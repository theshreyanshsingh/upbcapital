import { prisma } from "@/lib/prisma";

const POSTS = [
  {
    slug: "what-the-desk-trades",
    title: "What the desk actually trades",
    excerpt: "A mortgage note is the debt, not the house. The buyer is underwriting the paper and the collateral behind it.",
    body: "A note is the borrower’s promise to repay, secured by a mortgage or deed of trust. Buying the note is not buying the house. It is buying the right to the remaining payments, and the right to enforce the lien if those payments stop.\n\nUPB Capital lists that paper. A single loan from an individual, or a tape from a fund or a bank. The asking price is a number against unpaid principal. The premium sits on top and is shown before anyone asks for the file.\n\nStreet address and borrower name stay closed until the buyer signs confidentiality on that listing. The desk is not a lender, and it does not originate the loan.",
  },
];

export async function ensureStories() {
  if ((await prisma.post.count()) === 0) {
    // Two first visits can race here, and the loser only hits the unique slug. That must not fail the home page.
    await prisma.post
      .createMany({ data: POSTS.map((post) => ({ ...post, publishedAt: new Date("2026-10-01") })) })
      .catch(() => undefined);
  }
}
