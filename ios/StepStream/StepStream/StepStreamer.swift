import CoreLocation
import CoreMotion
import Foundation
import os
import UIKit

/// Counts steps since Start and POSTs them to the server every ~3 seconds.
///
/// Why location: iOS suspends a backgrounded app within seconds, and FaceTime will be in the foreground during the
/// call. A running location session with `allowsBackgroundLocationUpdates` (plus UIBackgroundModes: location) keeps
/// StepStream alive so the timer keeps firing. Accuracy is the coarsest level: we never read or send location.
///
/// Sending is driven ONLY by the timer, never by a pedometer callback. (v1 sent from inside a pedometer query
/// callback, so a query that never called back silently stopped all sends.) The pedometer just updates `steps`:
/// - `startUpdates` gives live counts (a few seconds behind, and only while walking),
/// - a periodic `queryPedometerData(from: Start, to: now)` on a SEPARATE CMPedometer corrects it if live updates lag.
@MainActor
final class StepStreamer: NSObject, ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var steps = 0
    @Published private(set) var status = "Tap Start before your coach call."
    @Published private(set) var lastSent: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var diag = Diagnostics()

    struct Diagnostics {
        var stepCountingAvailable = CMPedometer.isStepCountingAvailable()
        var motionAuth = "?"
        var locationAuth = "?"
        var appState = "?"
        var ticks = 0
        var liveUpdates = 0
        var liveLastAt: Date?
        var liveError: String?
        var queries = 0
        var queryLastAt: Date?
        var queryLastSteps: Int?
        var queryError: String?
        var sendsOK = 0
        var sendsFailed = 0
        var lastHTTP: Int?
        var sendError: String?
        var locationUpdates = 0
        var locationError: String?
    }

    private let log = Logger(subsystem: "StepStream", category: "streamer")
    private let livePedometer = CMPedometer()
    private let queryPedometer = CMPedometer()
    private let location = CLLocationManager()
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 6
        config.timeoutIntervalForResource = 8
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()
    private var timer: Timer?
    private var startDate = Date()
    private var sessionID = UUID().uuidString
    private var sendStartedAt: Date?
    private var queryStartedAt: Date?

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        location.distanceFilter = kCLDistanceFilterNone
        location.pausesLocationUpdatesAutomatically = false
        location.activityType = .fitness
        refreshAuth()
    }

    // MARK: Start / Stop

    func start() {
        guard !isRunning else { return }
        refreshAuth()
        guard CMPedometer.isStepCountingAvailable() else { status = "Step counting is not available on this device."; return }
        guard Settings.liveStepsURL != nil, !Settings.token.isEmpty else { status = "Open Settings and enter the server URL and token."; return }
        if CMPedometer.authorizationStatus() == .denied || CMPedometer.authorizationStatus() == .restricted {
            status = "Motion & Fitness is off for StepStream."
            lastError = "Turn it on: Settings > Privacy & Security > Motion & Fitness > Fitness Tracking ON, and StepStream ON."
            return
        }

        startDate = Date()
        sessionID = UUID().uuidString
        steps = 0
        lastError = nil
        diag = Diagnostics()
        isRunning = true
        status = "Running. Walk, then switch to FaceTime."
        log.info("start session \(self.sessionID, privacy: .public)")

        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
        location.allowsBackgroundLocationUpdates = true
        location.showsBackgroundLocationIndicator = true
        location.startUpdatingLocation()

        livePedometer.startUpdates(from: startDate) { [weak self] data, error in
            let count = data?.numberOfSteps.intValue
            let message = error.map(Self.describe)
            Task { @MainActor in self?.handleLive(count: count, error: message) }
        }

        // .common run loop mode so the timer also fires while the UI is being touched/scrolled.
        let t = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        tick()
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        timer?.invalidate()
        timer = nil
        livePedometer.stopUpdates()
        location.stopUpdatingLocation()
        location.allowsBackgroundLocationUpdates = false
        status = "Stopped at \(steps) steps."
        log.info("stop at \(self.steps) steps")
    }

    // MARK: Timer tick: always send, then refresh the count in the background

    private func tick() {
        guard isRunning else { return }
        diag.ticks += 1
        refreshAuth()
        Task { await send() }   // never waits on the pedometer
        runQuery()
    }

    private func handleLive(count: Int?, error: String?) {
        guard isRunning else { return }
        if let count {
            diag.liveUpdates += 1
            diag.liveLastAt = Date()
            steps = max(steps, count)
        }
        if let error { diag.liveError = error; log.error("live: \(error, privacy: .public)") }
    }

    private func runQuery() {
        // One query at a time; if one has hung for 10 s, give up on it and start another.
        if let started = queryStartedAt, Date().timeIntervalSince(started) < 10 { return }
        queryStartedAt = Date()
        diag.queries += 1
        queryPedometer.queryPedometerData(from: startDate, to: Date()) { [weak self] data, error in
            let count = data?.numberOfSteps.intValue
            let message = error.map(Self.describe)
            Task { @MainActor in
                guard let self else { return }
                self.queryStartedAt = nil
                self.diag.queryLastAt = Date()
                self.diag.queryLastSteps = count
                self.diag.queryError = message
                if let count, self.isRunning { self.steps = max(self.steps, count) }
                if let message { self.log.error("query: \(message, privacy: .public)") }
            }
        }
    }

    private func send() async {
        guard let url = Settings.liveStepsURL else { diag.sendError = "No server URL"; return }
        // One request at a time; a request stuck past 10 s is abandoned (URLSession times out at 6-8 s anyway).
        if let started = sendStartedAt, Date().timeIntervalSince(started) < 10 { return }
        let started = Date()
        sendStartedAt = started
        defer { if sendStartedAt == started { sendStartedAt = nil } }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(Settings.token)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "session_id": sessionID,
            "steps": steps,
            "started_at": ISO8601DateFormatter().string(from: startDate),
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            diag.lastHTTP = code
            if code == 200 {
                diag.sendsOK += 1
                diag.sendError = nil
                lastSent = Date()
            } else {
                diag.sendsFailed += 1
                let text = String(decoding: data.prefix(200), as: UTF8.self)
                diag.sendError = code == 401 ? "HTTP 401: token is wrong" : "HTTP \(code): \(text)"
                log.error("send HTTP \(code) \(text, privacy: .public)")
            }
        } catch {
            diag.sendsFailed += 1
            diag.lastHTTP = nil
            diag.sendError = Self.describe(error)
            log.error("send failed: \(Self.describe(error), privacy: .public)")
        }
    }

    // MARK: Status helpers

    private func refreshAuth() {
        diag.motionAuth = switch CMPedometer.authorizationStatus() {
        case .authorized: "allowed"
        case .denied: "DENIED"
        case .restricted: "RESTRICTED"
        case .notDetermined: "not asked yet"
        @unknown default: "unknown"
        }
        diag.locationAuth = switch location.authorizationStatus {
        case .authorizedAlways: "always"
        case .authorizedWhenInUse: "while using"
        case .denied: "DENIED"
        case .restricted: "RESTRICTED"
        case .notDetermined: "not asked yet"
        @unknown default: "unknown"
        }
        diag.appState = switch UIApplication.shared.applicationState {
        case .active: "foreground"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    nonisolated static func describe(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == CMErrorDomain {
            switch ns.code {
            case Int(CMErrorMotionActivityNotAuthorized.rawValue): return "Motion & Fitness not allowed (CMError 105)"
            case Int(CMErrorMotionActivityNotAvailable.rawValue): return "Motion data not available (CMError 104)"
            case Int(CMErrorMotionActivityNotEntitled.rawValue): return "Not entitled to motion data (CMError 106)"
            default: return "CoreMotion error \(ns.code)"
            }
        }
        return "\(ns.localizedDescription) (\(ns.domain) \(ns.code))"
    }

    /// Settings screen "Test connection": GET /live-steps with the token.
    static func testConnection() async -> String {
        guard let url = Settings.liveStepsURL else { return "Enter a server URL first." }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.setValue("Bearer \(Settings.token)", forHTTPHeaderField: "Authorization")
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200: return "Connected. The server accepted the token."
            case 401: return "Reached the server, but the token is wrong."
            case let code: return "Reached the server, but it returned HTTP \(code)."
            }
        } catch {
            return "Can't reach the server: \(describe(error))"
        }
    }
}

extension StepStreamer: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Locations are ignored; counting updates just proves the keep-alive is running.
        Task { @MainActor in self.diag.locationUpdates += 1 }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.refreshAuth()
            if status == .denied || status == .restricted {
                self.lastError = "Location is off for StepStream, so counting stops when you switch to FaceTime. Enable it in Settings > StepStream > Location."
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let message = StepStreamer.describe(error)
        Task { @MainActor in self.diag.locationError = message }
    }
}
