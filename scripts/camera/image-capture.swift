// Development-only PTP transport. Protocol mappings belong to the Node providers.
import Foundation
import ImageCaptureCore

final class CameraHost: NSObject, ICDeviceBrowserDelegate, ICCameraDeviceDelegate {
    let browser = ICDeviceBrowser()
    var cameras: [String: ICCameraDevice] = [:]
    var transaction: UInt32 = 0
    let outputLock = NSLock()
    let allowed: Set<UInt16> = [0x1001, 0x1004, 0x1005, 0x1007, 0x1008, 0x1009,
                                0x9201, 0x9202, 0x9205, 0x9207, 0x9209]

    override init() {
        super.init()
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: 0x101)!
        browser.start()
    }
    func emit(_ value: [String: Any]) {
        outputLock.lock()
        defer { outputLock.unlock() }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }
    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let camera = device as? ICCameraDevice else { return }
        cameras[UUID().uuidString] = camera
        camera.delegate = self
    }
    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        for (id, camera) in cameras where camera === device {
            cameras.removeValue(forKey: id)
            emit(["event": "disconnected", "camera": id])
        }
    }
    func handle(_ request: [String: Any]) {
        let id = request["id"] as? String ?? ""
        func reply(_ value: Any) { emit(["id": id, "result": value]) }
        func fail(_ message: String) { emit(["id": id, "error": message]) }
        if request["op"] as? String == "list" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
                reply(cameras.map { key, camera in
                    ["connection": key, "model": camera.name ?? "Unknown camera",
                     "serial": camera.serialNumberString ?? "", "vendor": camera.usbVendorID,
                     "product": camera.usbProductID, "location": camera.usbLocationID] as [String: Any]
                })
            }
            return
        }
        guard let key = request["camera"] as? String, let camera = cameras[key] else {
            fail("Camera disconnected. Discover again and open a new session.")
            return
        }
        switch request["op"] as? String {
        case "open":
            camera.requestOpenSession(options: nil) { error in
                if let error { fail(error.localizedDescription) } else { reply(["opened": true]) }
            }
        case "close":
            camera.requestCloseSession(options: nil) { error in
                if let error { fail(error.localizedDescription) } else { reply(["closed": true]) }
            }
        case "ptp":
            guard let number = request["code"] as? UInt16, allowed.contains(number),
                  let parameters = request["parameters"] as? [UInt32], parameters.count <= 5 else {
                fail("Unsupported PTP command")
                return
            }
            transaction &+= 1
            var command = Data()
            func append<T: FixedWidthInteger>(_ value: T) {
                var little = value.littleEndian
                withUnsafeBytes(of: &little) { command.append(contentsOf: $0) }
            }
            append(UInt32(12 + parameters.count * 4)); append(UInt16(1)); append(number)
            append(transaction)
            for parameter in parameters { append(parameter) }
            let outgoing = (request["data"] as? String).flatMap { Data(base64Encoded: $0) }
            camera.requestSendPTPCommand(command, outData: outgoing) { data, response, error in
                if let error { fail(error.localizedDescription); return }
                do {
                    if let path = request["file"] as? String {
                        guard number == 0x1009, data.count <= 512 * 1024 * 1024 else {
                            fail("Invalid original download"); return
                        }
                        try data.write(to: URL(fileURLWithPath: path), options: [.withoutOverwriting])
                        reply(["bytes": data.count, "response": response.base64EncodedString()])
                    } else {
                        guard data.count <= 2 * 1024 * 1024 else { fail("PTP response too large"); return }
                        reply(["data": data.base64EncodedString(), "response": response.base64EncodedString()])
                    }
                } catch { fail(error.localizedDescription) }
            }
        default: fail("Unknown transport operation")
        }
    }
    func didRemove(_ device: ICDevice) {}
    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {}
    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func device(_ device: ICDevice, didEncounterError error: Error?) {}
    func deviceDidBecomeReady(_ device: ICDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
    func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceivePTPEvent eventData: Data) {}
    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {}
    func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) {}
    func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: Error?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable: Any]?, for item: ICCameraItem, error: Error?) {}
}

let host = CameraHost()
DispatchQueue.global().async {
    while let line = readLine() {
        guard line.utf8.count <= 65536,
              let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { host.handle(request) }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
