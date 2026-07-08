import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate";
import { TopBar } from "@/components/TopBar";
import { DashboardPage } from "@/pages/DashboardPage";
import { AttemptDetailPage } from "@/pages/AttemptDetailPage";

function Main() {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <TopBar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/mimic/:ticket/:feature/:attempt" element={<AttemptDetailPage />} />
        </Routes>
      </main>
    </div>
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
