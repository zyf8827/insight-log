import { useState } from "react";
import "./App.css";
import { SearchForm } from "./SearchForm";
import { OldFileList } from "./OldFileList";
import { LogViewer } from "./LogViewer";
import { FileViewer } from "./FileViewer";

function App() {
  const [query, setQuery] = useState("");
  const [files] = useState<string[]>(["app.log", "error.log"]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="layout-wide-tree">
      <aside className="file-pane">
        <OldFileList files={files} />
      </aside>
      <main>
        <SearchForm onSearch={setQuery} />
        <LogViewer query={query} onOpen={setOpen} />
        {open ? <FileViewer path={open} onClose={() => setOpen(null)} /> : null}
      </main>
    </div>
  );
}

export default App;
