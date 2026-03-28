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
