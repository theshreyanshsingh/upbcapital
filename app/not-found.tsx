import Link from "next/link";
import { Logo } from "@/components/logo";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5">
      <Logo />
      <h1 className="mt-10 font-semibold tracking-tight text-6xl text-foreground">Not on the book.</h1>
      <p className="mt-4 text-muted-foreground">That page is not part of the desk.</p>
      <Link href="/" className="mt-6 text-[13px] font-medium text-link">Return</Link>
    </main>
  );
}
