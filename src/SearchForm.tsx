export function SearchForm({ onSearch }: { onSearch: (q: string) => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSearch(String(fd.get("q") || ""));
      }}
    >
      <input name="q" placeholder="error | timeout" />
      <button type="submit">Search</button>
    </form>
  );
}
