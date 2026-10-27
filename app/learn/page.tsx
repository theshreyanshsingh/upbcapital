import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";

export const metadata: Metadata = {
  title: "Learn the desk",
  description: "What a mortgage note is, how buying works, and how selling works at UPB Capital.",
};

const pieces = [
  ["What is a note", "The debt, the lien, and what a buyer actually owns.", "/learn/what-is-a-note"],
  ["How buying works", "Verification, confidentiality, the bid, and the closing.", "/learn/buying"],
  ["How selling works", "One loan or a tape, review, and the commission.", "/learn/selling"],
];

export default function LearnPage() {
  return (
    <PublicPage title="Read the paper before you bid." lede="Three short pages on what this desk trades, and how a file moves from a seller to a buyer.">
      <ul className="space-y-4">
        {pieces.map(([title, body, href]) => (
          <li key={href} className="border border-border p-5 rounded-xl">
            <Link href={href} className="font-semibold tracking-tight text-3xl text-foreground">{title}</Link>
            <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>
    </PublicPage>
  );
}
