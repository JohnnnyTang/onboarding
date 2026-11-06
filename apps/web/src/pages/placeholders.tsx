import { Link } from "react-router";
import { PageHeader } from "../components/ui";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}
