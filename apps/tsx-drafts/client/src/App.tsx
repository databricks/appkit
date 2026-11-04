import { createBrowserRouter, RouterProvider } from "react-router";

import { Builder } from "./Builder";
import { DraftPage } from "./Draft";

const router = createBrowserRouter([
  { path: "/", element: <Builder /> },
  { path: "/design/:name", element: <DraftPage /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
