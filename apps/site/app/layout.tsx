// SPDX-License-Identifier: AGPL-3.0-only
export const metadata = { title: "Nouvex Mail" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
