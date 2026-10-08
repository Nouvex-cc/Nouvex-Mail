// SPDX-License-Identifier: AGPL-3.0-only
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { db } from "./db";

await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
process.exit(0);
