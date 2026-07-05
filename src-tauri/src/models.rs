#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SearchResult {
    pub file_path: String,
    pub line_number: usize,
    pub content: String,
    pub context: Vec<String>,
    pub matched_positions: Vec<(usize, usize)>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct MergedSearchResult {
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub lines: Vec<LineResult>,
    pub match_count: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct LineResult {
    pub line_number: usize,
    pub content: String,
    pub is_match: bool,
    pub match_ranges: Option<Vec<(usize, usize)>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct SearchParams {
    pub directory: String,
    pub query: String,
    pub case_sensitive: bool,
    #[serde(default)]
    pub is_regex: bool,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_results: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct SkippedFileInfo {
    pub path: String,
    pub reason: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SearchResponse {
    pub results: Vec<MergedSearchResult>,
    pub total_count: usize,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default)]
    pub is_truncated: bool,
    #[serde(default)]
    pub skipped_files: Vec<SkippedFileInfo>,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct DroppedPathInfo {
    pub root_directory: String,
    pub is_directory: bool,
    pub file_name: Option<String>,
    pub is_archive: bool,
}
