// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import GRDB

struct Message: Codable, FetchableRecord, PersistableRecord {
    var id: String
    var accountId: String
    var subject: String
    var receivedAt: Date
}

enum Database {
    static func open(at path: String) throws -> DatabaseQueue {
        let db = try DatabaseQueue(path: path)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.create(table: "message") { t in
                t.primaryKey("id", .text)
                t.column("accountId", .text).notNull().indexed()
                t.column("subject", .text).notNull()
                t.column("receivedAt", .datetime).notNull()
            }
        }
        try migrator.migrate(db)
        return db
    }
}
