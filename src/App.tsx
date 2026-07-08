import { AuthGate } from "@/components/AuthGate";

function Main() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-bg">
      <h1 className="text-3xl font-bold text-ink">TenetX Mimic</h1>
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <Main />
    </AuthGate>
  );
}
