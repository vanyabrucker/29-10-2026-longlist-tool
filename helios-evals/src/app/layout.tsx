import type { Metadata } from "next";
import { DM_Mono, DM_Sans, Lora } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], axes: ["opsz"] });
const dmMono = DM_Mono({ variable: "--font-dm-mono", subsets: ["latin"], weight: ["400", "500"] });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Helios Evals",
  description: "Eval runs, improvement proposals and chat feedback for the Helios agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmMono.variable} ${lora.variable} h-full antialiased`}
    >
      <body className="h-full font-sans">{children}</body>
    </html>
  );
}
