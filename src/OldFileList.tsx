/** Legacy non-virtual file list — to be replaced */
export function OldFileList({ files }: { files: string[] }) {
  return (
    <ul className="old-file-list">
      {files.map((f) => (
        <li key={f}>{f}</li>
      ))}
    </ul>
  );
}
