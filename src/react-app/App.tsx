import { BrowserRouter as Router, Routes, Route } from "react-router";
import HomePage from "@/react-app/pages/Home";
import LlmSettingsPage from "@/react-app/pages/LlmSettings";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings/llm" element={<LlmSettingsPage />} />
      </Routes>
    </Router>
  );
}
