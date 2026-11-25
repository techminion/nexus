import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api";
import { App } from "./App";
import "./index.css";

// Last theme used on this device, so the page doesn't flash the default before settings load.
try {
  document.documentElement.dataset.theme = localStorage.getItem("theme") ?? "dark";
  document.documentElement.dataset.skin = localStorage.getItem("skin") ?? "brutal";
} catch { /* storage blocked */ }

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof ApiError && e.status === 401) queryClient.setQueryData(["session"], { authenticated: false });
    },
  }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
