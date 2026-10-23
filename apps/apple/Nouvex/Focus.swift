// SPDX-License-Identifier: AGPL-3.0-only
import Foundation

/// When a group is read; days are 0 (Sunday) to 6, times are this device's.
struct Focus: Codable, Hashable, Sendable {
    var days: [Int]
    var from: String
    var to: String

    private func minutes(_ t: String) -> Int { (Int(t.prefix(2)) ?? 0) * 60 + (Int(t.suffix(2)) ?? 0) }

    func within(_ at: Date) -> Bool {
        let c = Calendar.current.dateComponents([.weekday, .hour, .minute], from: at)
        let now = (c.hour ?? 0) * 60 + (c.minute ?? 0), day = (c.weekday ?? 1) - 1
        let (start, end) = (minutes(from), minutes(to))
        if start < end { return days.contains(day) && now >= start && now < end }
        // Over midnight it belongs to the day it started.
        return (days.contains(day) && now >= start) || (days.contains((day + 6) % 7) && now < end)
    }

    /// When it starts again after `at`.
    func wakes(after at: Date) -> Date? {
        (0...7).lazy.compactMap { d -> Date? in
            guard let day = Calendar.current.date(byAdding: .day, value: d, to: at) else { return nil }
            return Calendar.current.date(bySettingHour: minutes(from) / 60, minute: minutes(from) % 60, second: 0, of: day)
        }
        .first { $0 > at && days.contains(Calendar.current.component(.weekday, from: $0) - 1) }
    }
}
