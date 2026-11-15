import SwiftUI

@main
struct StepStreamApp: App {
    @StateObject private var streamer = StepStreamer()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(streamer)
        }
    }
}
