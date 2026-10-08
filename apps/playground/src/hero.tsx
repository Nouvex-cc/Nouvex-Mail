// SPDX-License-Identifier: AGPL-3.0-only
// Product image for the UI library: open /#hero and screenshot the 1600×900 frame.
import {
	AccountSwitcher,
	Avatar,
	BulkBar,
	Button,
	Calendar,
	Checkbox,
	Field,
	Kbd,
	LabelChip,
	MessageList,
	MessageRow,
	Meter,
	OTPField,
	Progress,
	Radio,
	RadioGroup,
	RangeCalendar,
	SearchField,
	Select,
	Sidebar,
	Slider,
	Switch,
	Tabs,
	Toggle,
	ToggleGroup,
} from "@nouvex/ui";
import { Archive, Bold, Copy, Inbox, Italic, Send, Star, Underline } from "@nouvex/ui/icons";
import type { ReactNode } from "react";

const today = new Date();
const day = (d: number, h = 9) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - d, h, 12);
const accounts = [
	{ id: "work", name: "Mateo Coerdts", email: "mateo@nouvex.cc", unread: true },
	{ id: "home", name: "Mateo", email: "mateo@icloud.com" },
];

const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
	<div className={`mb-4 break-inside-avoid rounded-xl border border-line bg-paper p-5 shadow-pop ${className}`}>
		{children}
	</div>
);

function Tiles({ shift = 0 }: { shift?: number }) {
	const tiles = [
		<Card key="t1">
			<Calendar mode="single" selected={day(-2)} defaultMonth={today} />
		</Card>,
		<Card key="t2">
			<MessageList>
				<MessageRow from="Lena Hartmann" subject="Keys for the new flat" date={day(0)} unread />
				<MessageRow
					from="Deutsche Bahn"
					subject="Your ticket to Berlin"
					labels={[{ name: "Travel", color: "blue" }]}
					date={day(0, 7)}
					unread
					attachments={1}
				/>
				<MessageRow from="Jonas Weber" subject="Re: Saturday" date={day(1)} selected selecting />
				<MessageRow
					from="Hetzner Online"
					subject="Invoice R0012345678"
					labels={[{ name: "Receipts", color: "green" }]}
					date={day(3)}
				/>
			</MessageList>
		</Card>,
		<Card key="t3" className="flex flex-wrap gap-2">
			<Button variant="primary">
				<Send strokeWidth={1.75} />
				Send
			</Button>
			<Button success="Saved">Save draft</Button>
			<Button variant="ghost">Cancel</Button>
			<Button variant="primary" loading>
				Sending
			</Button>
			<Button variant="danger">Delete</Button>
		</Card>,
		<Card key="t4" className="grid gap-3">
			<label className="flex items-center gap-2">
				<Switch defaultChecked /> Load remote images
			</label>
			<label className="flex items-center gap-2">
				<Checkbox defaultChecked /> Show snippets
			</label>
			<RadioGroup defaultValue="comfortable">
				<label className="flex items-center gap-2">
					<Radio value="compact" /> Compact
				</label>
				<label className="flex items-center gap-2">
					<Radio value="comfortable" /> Comfortable
				</label>
			</RadioGroup>
		</Card>,
		<Card key="t5" className="h-80 p-0">
			<Sidebar.Root>
				<AccountSwitcher accounts={accounts} current="work" onChange={() => {}} />
				<Sidebar.Section>
					<Sidebar.Item label="Inbox" icon={<Inbox strokeWidth={1.75} />} unread active onSelect={() => {}} />
					<Sidebar.Item label="Starred" icon={<Star strokeWidth={1.75} />} onSelect={() => {}} />
					<Sidebar.Item label="Archive" icon={<Archive strokeWidth={1.75} />} onSelect={() => {}} />
				</Sidebar.Section>
				<Sidebar.Section title="Labels">
					<Sidebar.Label label="Travel" color="blue" onSelect={() => {}} />
					<Sidebar.Label label="Family" color="orange" onSelect={() => {}} />
				</Sidebar.Section>
			</Sidebar.Root>
		</Card>,
		<Card key="t6">
			<SearchField onSearch={() => {}} />
		</Card>,
		<Card key="t7" className="grid gap-4">
			<Slider label="Text size" defaultValue={40} showValue />
			<Progress value={64} label="Uploading invoice.pdf" />
			<Meter value={42} label="Storage" />
		</Card>,
		<Card key="t8" className="grid gap-3">
			<div className="flex items-center gap-3">
				<Avatar name="Lena Hartmann" size="lg" />
				<div className="grid flex-1">
					<span className="font-medium">Lena Hartmann</span>
					<span className="text-sm text-muted">lena@hartmann.example</span>
				</div>
				<span className="text-muted">
					<Copy strokeWidth={1.75} className="size-4" />
				</span>
			</div>
		</Card>,
		<Card key="t9">
			<RangeCalendar value={{ from: day(4), to: day(-3) }} onChange={() => {}} />
		</Card>,
		<Card key="t10" className="grid gap-4">
			<Field.Root>
				<Field.Label>Display name</Field.Label>
				<Field.Control defaultValue="Mateo" />
			</Field.Root>
			<Select.Root defaultValue="hour" items={{ instant: "Instantly", hour: "Every hour", day: "Daily digest" }}>
				<Select.Trigger className="w-full" />
				<Select.Popup>
					<Select.Item value="instant">Instantly</Select.Item>
					<Select.Item value="hour">Every hour</Select.Item>
					<Select.Item value="day">Daily digest</Select.Item>
				</Select.Popup>
			</Select.Root>
			<OTPField />
		</Card>,
		<Card key="t11" className="flex flex-wrap items-center gap-3">
			<ToggleGroup multiple defaultValue={["bold"]}>
				<Toggle value="bold" aria-label="Bold">
					<Bold strokeWidth={1.75} />
				</Toggle>
				<Toggle value="italic" aria-label="Italic">
					<Italic strokeWidth={1.75} />
				</Toggle>
				<Toggle value="underline" aria-label="Underline">
					<Underline strokeWidth={1.75} />
				</Toggle>
			</ToggleGroup>
			<LabelChip name="Travel" color="blue" />
			<LabelChip name="Receipts" color="green" />
			<LabelChip name="Family" color="orange" />
			<span className="flex items-center gap-1 text-sm text-muted">
				<Kbd>⌘</Kbd>
				<Kbd>K</Kbd>
			</span>
		</Card>,
		<Card key="t12">
			<Tabs.Root defaultValue="general">
				<Tabs.List>
					<Tabs.Tab value="general">General</Tabs.Tab>
					<Tabs.Tab value="accounts">Accounts</Tabs.Tab>
					<Tabs.Tab value="shortcuts">Shortcuts</Tabs.Tab>
				</Tabs.List>
			</Tabs.Root>
		</Card>,
		<Card key="t13" className="relative h-20 p-0">
			<BulkBar count={3} onArchive={() => {}} onDelete={() => {}} onMarkRead={() => {}} onClear={() => {}} />
		</Card>,
	];
	// Each copy starts somewhere else in the list, so the same tile never sits next to itself.
	return tiles.map((_, i) => tiles[(i + shift) % tiles.length]);
}

export function Hero() {
	return (
		<div className="hero">
			<div className="hero-tiles">
				<div className="hero-field">
					<div className="columns-6 gap-4">
						<Tiles />
						<Tiles shift={5} />
						<Tiles shift={9} />
						<Tiles shift={3} />
						<Tiles shift={7} />
					</div>
				</div>
			</div>
			<div className="hero-brand">
				<span role="img" aria-label="Nouvex" className="logo hero-logo" />
				<span className="hero-ui">ui</span>
			</div>
			<div className="hero-grain" />
		</div>
	);
}
