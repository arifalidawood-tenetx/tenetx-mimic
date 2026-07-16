import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate";
import { AppShell } from "@/components/shell/AppShell";
import { DashboardPage } from "@/pages/DashboardPage";
import { AttemptDetailPage } from "@/pages/AttemptDetailPage";
import { TryItOutPage } from "@/pages/TryItOutPage";
import { McpPage } from "@/pages/McpPage";

function Main() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/mimic/try-it-out" element={<TryItOutPage />} />
        <Route path="/mimic/:ticket/try-it-out" element={<TryItOutPage />} />
        <Route path="/mimic/:ticket/:feature/:attempt" element={<AttemptDetailPage />} />
        <Route path="/mcp" element={<McpPage />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Main />
      </AuthGate>
    </BrowserRouter>
  );
}
