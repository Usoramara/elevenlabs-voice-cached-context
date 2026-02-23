import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Wybe',
  description: 'Alive voice interface',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="no">
      <body style={{ margin: 0, background: '#0a0a0a' }}>{children}</body>
    </html>
  );
}
