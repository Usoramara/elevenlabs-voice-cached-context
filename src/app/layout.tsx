export const metadata = {
  title: 'ElevenLabs Voice Pipeline',
  description: 'Dual-layer cached LLM proxy for ElevenLabs Conversational AI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
