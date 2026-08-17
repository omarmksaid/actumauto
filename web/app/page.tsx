import { redirect } from "next/navigation";

// Land on Today. In demo mode the (app) guard is a no-op; otherwise it redirects to /login
// when there's no session.
export default function Home() {
  redirect("/today");
}
