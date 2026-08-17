import { redirect } from "next/navigation";

// Slice 1: land straight on Imports (the working vertical slice). A marketing/login
// front door arrives with the auth slice.
export default function Home() {
  redirect("/imports");
}
