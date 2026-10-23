// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import Testing

/// The same cases as apps/web/src/accounts.test.ts, so both rest at the same times.
struct FocusTests {
    let work = Focus(days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00")

    // 2026-10-23 is a Friday.
    func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    @Test func restsOutsideItsTimes() {
        #expect(!work.within(at(23, 8, 59)))
        #expect(work.within(at(23, 9)))
        #expect(!work.within(at(23, 18)))
        #expect(!work.within(at(24, 12)))
        #expect(work.wakes(after: at(23, 19)) == at(26, 9))
    }

    @Test func runsPastMidnight() {
        let night = Focus(days: [5], from: "22:00", to: "02:00")
        #expect(night.within(at(23, 23)))
        #expect(night.within(at(24, 1, 59)))
        #expect(!night.within(at(24, 2)))
        #expect(!night.within(at(24, 23)))
    }
}
