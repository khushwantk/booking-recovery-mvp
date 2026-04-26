import { Route, Routes } from "react-router-dom";
import { DemoBookingFlow } from "./DemoBookingFlow";
import { PolicyPage } from "./PolicyPage";
import { ResumePage } from "./ResumePage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<DemoBookingFlow />} />
      <Route path="/resume" element={<ResumePage />} />
      <Route path="/policies/:file" element={<PolicyPage />} />
    </Routes>
  );
}
