import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var streamer: StepStreamer
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
            VStack(spacing: 28) {
                Spacer()
                VStack(spacing: 4) {
                    Text("\(streamer.steps)")
                        .font(.system(size: 88, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    Text("steps since Start")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }

                Button {
                    streamer.isRunning ? streamer.stop() : streamer.start()
                } label: {
                    Text(streamer.isRunning ? "Stop" : "Start")
                        .font(.title2.bold())
                        .frame(maxWidth: .infinity, minHeight: 64)
                }
                .buttonStyle(.borderedProminent)
                .tint(streamer.isRunning ? .red : .green)
                .padding(.horizontal, 32)

                VStack(spacing: 8) {
                    Text(streamer.status)
                    if let sent = streamer.lastSent {
                        Text("Last sent \(sent.formatted(date: .omitted, time: .standard))")
                            .foregroundStyle(.secondary)
                    }
                    if let error = streamer.lastError {
                        Text(error).foregroundStyle(.red)
                    }
                }
                .font(.footnote)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

                DiagnosticsPanel(diag: streamer.diag, running: streamer.isRunning)
                    .padding(.horizontal, 16)
                Spacer()
            }
            .padding(.vertical, 24)
            }
            .navigationTitle("StepStream")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                        .disabled(streamer.isRunning)
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var url = Settings.serverURL
    @State private var token = Settings.token
    @State private var testResult: String?
    @State private var testing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://your-tunnel.trycloudflare.com", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: { Text("Server URL") } footer: {
                    Text("Your cloudflared tunnel address. It changes each time cloudflared restarts.")
                }
                Section {
                    SecureField("STEPS_TOKEN", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: { Text("Token") } footer: {
                    Text("Same STEPS_TOKEN as in .env.local. Stored in this iPhone's Keychain only.")
                }
                Section {
                    Button(testing ? "Testing…" : "Test connection") {
                        save()
                        testing = true
                        Task {
                            testResult = await StepStreamer.testConnection()
                            testing = false
                        }
                    }
                    .disabled(testing)
                    if let testResult { Text(testResult).font(.footnote) }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(); dismiss() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func save() {
        Settings.serverURL = url
        Settings.token = token
    }
}

/// What is (and isn't) working, so a failure is visible on the phone instead of silent.
struct DiagnosticsPanel: View {
    let diag: StepStreamer.Diagnostics
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            row("Motion & Fitness", diag.motionAuth, bad: diag.motionAuth != "allowed")
            row("Location", diag.locationAuth, bad: diag.locationAuth != "while using" && diag.locationAuth != "always")
            row("Step counting", diag.stepCountingAvailable ? "available" : "NOT AVAILABLE", bad: !diag.stepCountingAvailable)
            row("App", diag.appState, bad: false)
            Divider()
            row("Timer ticks", "\(diag.ticks)", bad: running && diag.ticks == 0)
            row("Sends ok / failed", "\(diag.sendsOK) / \(diag.sendsFailed)", bad: diag.sendsFailed > 0)
            row("Last HTTP", diag.lastHTTP.map(String.init) ?? "-", bad: diag.lastHTTP.map { $0 != 200 } ?? false)
            if let e = diag.sendError { error("Send", e) }
            Divider()
            row("Live updates", "\(diag.liveUpdates)" + ago(diag.liveLastAt), bad: false)
            if let e = diag.liveError { error("Live", e) }
            row("Queries", "\(diag.queries), last = " + (diag.queryLastSteps.map(String.init) ?? "-") + ago(diag.queryLastAt), bad: false)
            if let e = diag.queryError { error("Query", e) }
            row("Location keep-alive", "\(diag.locationUpdates) updates", bad: running && diag.ticks > 3 && diag.locationUpdates == 0)
            if let e = diag.locationError { error("Location", e) }
        }
        .font(.caption.monospaced())
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private func row(_ label: String, _ value: String, bad: Bool) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).foregroundStyle(bad ? .red : .primary)
        }
    }

    private func error(_ label: String, _ text: String) -> some View {
        Text("\(label): \(text)").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
    }

    private func ago(_ date: Date?) -> String {
        guard let date else { return "" }
        return " (\(Int(Date().timeIntervalSince(date)))s ago)"
    }
}
