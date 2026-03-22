import { useState } from "react";
import "./App.css";
import { SearchForm } from "./SearchForm";
import { OldFileList } from "./OldFileList";
import { LogViewer } from "./LogViewer";

function App() {
  const [query, setQuery] = useState("");
  const [files] = useState<string[]>(["app.log", "error.log"]);
  return (
    <div className="layout-wide-tree">
      <aside className="file-pane">
        <OldFileList files={files} />
      </aside>
      <main>
        <SearchForm onSearch={setQuery} />
        <LogViewer query={query} />
      </main>
    </div>
  );
}

export default App;
