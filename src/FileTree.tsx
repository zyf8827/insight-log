import React, { useState, useEffect } from 'react';
import { Tree, Spin, message } from 'antd';
import { FolderOutlined, FileOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

interface TreeNode {
  key: string;
  title: string;
  isLeaf?: boolean;
  children?: TreeNode[];
  type: 'directory' | 'file';
}

interface FileTreeProps {
  directory: string;
  onFileDoubleClick: (filePath: string) => void;
}

const FileTree: React.FC<FileTreeProps> = ({ directory, onFileDoubleClick }) => {
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  // 从 Rust 后端获取目录结构
  useEffect(() => {
    if (!directory) {
      setTreeData([]);
      return;
    }

    const loadDirectoryStructure = async () => {
      setLoading(true);
      try {
        const result: TreeNode[] = await invoke('get_directory_structure', {
          directory
        });
        setTreeData(result);
      } catch (error) {
        console.error('加载目录结构失败:', error);
        message.error('加载目录结构失败');
        setTreeData([]);
      } finally {
        setLoading(false);
      }
    };

    loadDirectoryStructure();
  }, [directory]);



  const onSelect = (_selectedKeys: React.Key[]) => {
    // 选择节点时什么都不做，双击处理
  };

  const onDoubleClick = (key: React.Key) => {
    const findNode = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) {
        if (node.key === key) {
          return node;
        }
        if (node.children) {
          const found = findNode(node.children);
          if (found) return found;
        }
      }
      return undefined;
    };

    const node = findNode(treeData);
    if (node && node.type === 'file') {
      onFileDoubleClick(node.key);
    }
  };



  return (
    <Spin spinning={loading}>
      <div style={{ height: '100%', overflow: 'auto' }}>
        <Tree
          treeData={treeData}
          onSelect={onSelect}
          onDoubleClick={(_, node) => onDoubleClick(node.key)}
          titleRender={(nodeData) => (
            <span onDoubleClick={(e) => {
              e.stopPropagation();
              onDoubleClick(nodeData.key);
            }}>
              {nodeData.title}
            </span>
          )}
          switcherIcon={({ isLeaf }) => isLeaf ? <FileOutlined /> : <FolderOutlined />}
        />
      </div>
    </Spin>
  );
};

export default FileTree;