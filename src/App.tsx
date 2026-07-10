import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate";
import { TopBar } from "@/components/TopBar";
import { Breadcrumb } from "@/components/Breadcrumb";
import { DashboardPage } from "@/pages/DashboardPage";
import { AttemptDetailPage } from "@/pages/AttemptDetailPage";
import { TryItOutPage } from "@/pages/TryItOutPage";

function Main() {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <TopBar />
      <div className="flex flex-1 flex-col lg:min-w-0 lg:pl-64">
        <Breadcrumb />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/mimic/try-it-out" element={<TryItOutPage />} />
            <Route path="/mimic/:ticket/try-it-out" element={<TryItOutPage />} />
            <Route path="/mimic/:ticket/:feature/:attempt" element={<AttemptDetailPage />} />
          </Routes>
        </main>
      </div>
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
