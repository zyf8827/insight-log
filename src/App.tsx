import { useState } from "react";
import "./App.css";

function App() {
  const [dir, setDir] = useState<string>("");
  return (
    <div className="layout-wide-tree">
      <aside className="file-pane">Files (placeholder)</aside>
      <main>
        <h1>Insight Log</h1>
        <p>Directory: {dir || "(none)"}</p>
        <button type="button" onClick={() => setDir("/tmp/logs")}>Pick dir</button>
      </main>
    </div>
  );
}

export default App;
