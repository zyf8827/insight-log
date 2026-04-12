use crate::models::{SearchResult, MergedSearchResult, LineResult};
use regex::{Regex, RegexBuilder};
use std::collections::HashMap;

/// 合并重叠的搜索结果
/// 
/// 将相同文件中上下文重叠的多个搜索结果合并成一个结果，避免重复显示上下文行
pub fn merge_search_results(
    results: Vec<SearchResult>,
    context_lines: usize,
) -> Vec<MergedSearchResult> {
    if results.is_empty() {
        return vec![];
    }

    let mut sorted_results = results;
    // 按文件路径和行号排序
    sorted_results.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.line_number.cmp(&b.line_number))
    });

    let mut merged_results = Vec::new();
    let mut i = 0;

    while i < sorted_results.len() {
        let mut current_batch = vec![sorted_results[i].clone()];
        let base_file_path = &sorted_results[i].file_path;

        // 在同一文件中查找所有上下文重叠的结果
        i += 1;
        while i < sorted_results.len() && sorted_results[i].file_path == *base_file_path {
            let current_result = &sorted_results[i];
            let last_result = current_batch.last().unwrap();

            // 检查上下文是否重叠
            // 当前结果上下文: [current_result.line_number - context_lines, current_result.line_number + context_lines]
            // 最后结果上下文: [last_result.line_number - context_lines, last_result.line_number + context_lines]
            // 重叠条件: current_start <= last_end AND current_end >= last_start
            let current_start = if current_result.line_number > context_lines {
                current_result.line_number - context_lines
            } else {
                0
            };
            let last_end = last_result.line_number + context_lines;

            if current_start <= last_end {
                // 上下文重叠，添加到当前批次
                current_batch.push(current_result.clone());
            } else {
                // 没有重叠，跳出并处理当前批次
                break;
            }
            i += 1;
        }

        // 处理当前批次以创建合并结果
        if !current_batch.is_empty() {
            merged_results.push(create_merged_result(current_batch, context_lines));
        }
    }

    merged_results
}

/// 创建合并搜索结果
/// 
/// 将多个搜索结果的上下文合并到一个连续的代码段中，并保留匹配信息
fn create_merged_result(results: Vec<SearchResult>, context_lines: usize) -> MergedSearchResult {
    if results.is_empty() {
        return MergedSearchResult {
            file_path: String::new(),
            start_line: 0,
            end_line: 0,
            lines: vec![],
            match_count: 0,
        };
    }

    // 创建一个映射来存储行及其属性
    let mut lines_map = HashMap::new();
    let mut min_line = std::usize::MAX;
    let mut max_line = 0;

    // 添加每个匹配行及其上下文
    for result in &results {
        for (idx, context_line) in result.context.iter().enumerate() {
            // 根据上下文索引计算实际行号
            let actual_line_num = (if result.line_number > context_lines {
                result.line_number - context_lines
            } else {
                1
            }) + idx;

            // 检查这是否是上下文中的匹配行
            let is_match_line = actual_line_num == result.line_number;

            if actual_line_num < min_line {
                min_line = actual_line_num;
            }
            if actual_line_num > max_line {
                max_line = actual_line_num;
            }

            // 获取或更新映射中的行
            if !lines_map.contains_key(&actual_line_num) {
                lines_map.insert(
                    actual_line_num,
                    LineResult {
                        line_number: actual_line_num,
                        content: context_line.clone(),
                        is_match: is_match_line,
                        match_ranges: if is_match_line {
                            Some(result.matched_positions.clone())
                        } else {
                            None
                        },
                    },
                );
            } else {
                // 行已存在，更新匹配属性
                let line = lines_map.get_mut(&actual_line_num).unwrap();
                if is_match_line {
                    line.is_match = true;
                    let mut ranges = line.match_ranges.take().unwrap_or_default();
                    ranges.extend(result.matched_positions.clone());
                    ranges.sort_unstable();
                    ranges.dedup();
                    line.match_ranges = Some(ranges);
                }
            }
        }
    }

    if min_line == std::usize::MAX {
        min_line = results[0].line_number;
        max_line = results[0].line_number;
    }

    // 转换为排序向量
    let mut lines: Vec<LineResult> = lines_map.into_values().collect();
    lines.sort_by(|a, b| a.line_number.cmp(&b.line_number));

    MergedSearchResult {
        file_path: results[0].file_path.clone(),
        start_line: min_line,
        end_line: max_line,
        lines,
        match_count: results.len(), // 原始匹配数
    }
}

/// 解析搜索查询字符串
/// 
/// 将管道符分隔的查询字符串拆分为多个搜索模式
/// 例如: "error | timeout | 500" -> ["error", "timeout", "500"]
pub fn parse_query(query: &str) -> Vec<String> {
    query
        .split('|')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 编译搜索模式为正则表达式
/// 
/// 将字符串模式转换为正则表达式对象，支持字面量匹配（默认转义）或真实正则表达式匹配
pub fn compile_patterns(
    patterns: &[String],
    case_sensitive: bool,
    is_regex: bool,
) -> Result<Vec<Regex>, String> {
    let mut compiled = Vec::new();

    for pattern in patterns {
        if pattern.is_empty() {
            continue;
        }

        let pattern_str = if is_regex {
            pattern.clone()
        } else {
            regex::escape(pattern)
        };

        let mut builder = RegexBuilder::new(&pattern_str);
        builder.case_insensitive(!case_sensitive);
        builder.multi_line(true);
        builder.unicode(true);

        let regex = builder
            .build()
            .map_err(|e| format!("无效的查询模式 '{}': {}", pattern, e))?;
        compiled.push(regex);
    }

    if compiled.is_empty() {
        return Err("查询不能为空".to_string());
    }

    Ok(compiled)
}

/// 检查一行是否匹配所有模式（AND操作）
/// 
/// 对一行文本检查是否匹配所有提供的正则表达式模式，返回所有匹配的位置
pub fn matches_all_patterns(line: &str, patterns: &[Regex]) -> Vec<(usize, usize)> {
    let mut all_positions = Vec::new();

    for regex in patterns {
        let mut pattern_matches = Vec::new();
        // 查找当前模式在行中的所有匹配
        for mat in regex.find_iter(line) {
            pattern_matches.push((mat.start(), mat.end()));
        }

        // 如果任何模式不匹配，则整个链失败
        if pattern_matches.is_empty() {
            return Vec::new();
        }

        // 将字节索引转换为字符索引
        for (start_byte, end_byte) in pattern_matches {
            let start_char = byte_to_char_index(line, start_byte);
            let end_char = byte_to_char_index(line, end_byte);
            all_positions.push((start_char, end_char));
        }
    }

    // 按位置排序
    all_positions.sort_unstable();
    all_positions
}

fn byte_to_char_index(s: &str, byte_idx: usize) -> usize {
    if byte_idx >= s.len() {
        return s.chars().count();
    }

    s[..byte_idx].chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_query() {
        let q = "error | timeout | 500";
        let parsed = parse_query(q);
        assert_eq!(parsed, vec!["error", "timeout", "500"]);

        let q_spaces = "  foo  |   bar   | ";
        assert_eq!(parse_query(q_spaces), vec!["foo", "bar"]);
    }

    #[test]
    fn test_compile_patterns_literal_mode() {
        // In literal mode, regex special characters like [test] shouldn't fail or act as char sets
        let patterns = vec!["[ERROR]".to_string(), "timeout*".to_string()];
        let compiled = compile_patterns(&patterns, false, false).unwrap();
        assert_eq!(compiled.len(), 2);

        // Should match literal "[ERROR] timeout*"
        let line = "2026-09-22 [ERROR] something timeout* occurred";
        let matches = matches_all_patterns(line, &compiled);
        assert!(!matches.is_empty());

        // Should not match without square brackets
        let line2 = "2026-09-22 ERROR something timeout";
        let matches2 = matches_all_patterns(line2, &compiled);
        assert!(matches2.is_empty());
    }

    #[test]
    fn test_compile_patterns_regex_mode() {
        let patterns = vec![r"err(or)?-\d{3}".to_string()];
        let compiled = compile_patterns(&patterns, false, true).unwrap();
        assert_eq!(compiled.len(), 1);

        let line = "request failed with err-500";
        let matches = matches_all_patterns(line, &compiled);
        assert_eq!(matches, vec![(20, 27)]);

        // Invalid regex should return error
        let invalid = vec![r"(unclosed".to_string()];
        assert!(compile_patterns(&invalid, false, true).is_err());
    }

    #[test]
    fn test_matches_all_patterns_and_logic() {
        let patterns = vec!["error".to_string(), "timeout".to_string()];
        let compiled = compile_patterns(&patterns, false, false).unwrap();

        // Must match BOTH (AND logic)
        let both = "connection timeout with error";
        assert!(!matches_all_patterns(both, &compiled).is_empty());

        let only_error = "only error occurred";
        assert!(matches_all_patterns(only_error, &compiled).is_empty());

        let only_timeout = "only timeout occurred";
        assert!(matches_all_patterns(only_timeout, &compiled).is_empty());
    }

    #[test]
    fn test_merge_search_results() {
        let results = vec![
            SearchResult {
                file_path: "app.log".to_string(),
                line_number: 10,
                content: "error 1".to_string(),
                context: vec!["c9".to_string(), "error 1".to_string(), "c11".to_string()],
                matched_positions: vec![(0, 5)],
            },
            SearchResult {
                file_path: "app.log".to_string(),
                line_number: 12,
                content: "error 2".to_string(),
                context: vec!["c11".to_string(), "error 2".to_string(), "c13".to_string()],
                matched_positions: vec![(0, 5)],
            },
        ];

        let merged = merge_search_results(results, 2);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].match_count, 2);
        assert_eq!(merged[0].file_path, "app.log");
    }
}