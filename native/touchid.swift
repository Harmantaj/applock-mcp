// applock-touchid — tiny helper that gates a Keychain secret behind Touch ID.
//   applock-touchid available            exit 0 if biometrics (or device passcode) can be used
//   applock-touchid store <account>      read secret from stdin, save to Keychain
//   applock-touchid retrieve <account> <reason>   Touch ID prompt, then print secret
//   applock-touchid delete <account>
import Foundation
import LocalAuthentication
import Security

let service = "applock-mcp"
let args = CommandLine.arguments

func fail(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: account]
}

guard args.count >= 2 else { fail("usage: applock-touchid available|store|retrieve|delete") }

switch args[1] {
case "available":
    var err: NSError?
    let ctx = LAContext()
    if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) {
        print("biometrics"); exit(0)
    }
    if ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) {
        print("passcode"); exit(0)
    }
    fail(err?.localizedDescription ?? "unavailable", 2)

case "store":
    guard args.count >= 3 else { fail("missing account") }
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    SecItemDelete(query(args[2]) as CFDictionary)
    var add = query(args[2])
    add[kSecValueData as String] = secret
    add[kSecAttrLabel as String] = "AppLock vault key"
    let status = SecItemAdd(add as CFDictionary, nil)
    if status != errSecSuccess { fail("keychain store failed: \(status)") }

case "retrieve":
    guard args.count >= 4 else { fail("missing account or reason") }
    let ctx = LAContext()
    ctx.localizedFallbackTitle = "Use Password"
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var authError: Error?
    ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args[3]) { success, error in
        ok = success; authError = error; sem.signal()
    }
    sem.wait()
    if !ok { fail("authentication failed: \(authError?.localizedDescription ?? "cancelled")", 3) }
    var q = query(args[2])
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { fail("keychain read failed: \(status)", 4) }
    FileHandle.standardOutput.write(data)

case "delete":
    guard args.count >= 3 else { fail("missing account") }
    SecItemDelete(query(args[2]) as CFDictionary)

default:
    fail("unknown command \(args[1])")
}
