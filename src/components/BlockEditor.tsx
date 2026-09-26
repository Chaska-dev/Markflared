import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Block as BlockType, BlockType as BType } from '../types';
import { Block } from './Block';
import { SlashMenu } from './SlashMenu';
import { api } from '../api/client';
import { usePageContext } from '../contexts/PageContext';
// Shared markdown parser (same module used by the backend on import). Used to
// split multi-line or markdown-marked pastes into multiple blocks. The
// "looks like markdown" heuristic lives in the handler; this is just the parser.
import { parseMarkdownToBlocks } from '../../server/shared/markdown';

interface Props {
  pageId: string;
  initialBlocks: BlockType[];
}

// Debounce + flush: batches changes so we don't hammer the server, but ensures
// that on editor unmount (page navigation, refresh, tab close) the latest
// pending change is persisted. Fixes the bug where the user typed and
// navigated before the 500ms debounce fired.
function debounceWithFlush<T extends (...args: any[]) => any>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Parameters<T> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    pendingArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      if (a) fn(...a);
    }, ms);
  };
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      if (a) {
        // fire-and-forget; flush is synchronous from the caller.
        Promise.resolve(fn(...a)).catch(() => {});
      }
    }
  };
  return { debounced: wrapped, flush };
}

// Tree helpers.
// Blocks live in a flat list with `parent_id` (markflare-style). We build the
// tree once per render to display the hierarchy. `position` orders siblings
// under the same parent.

interface FlattenOpts {
  // IDs whose children should not be shown (an ancestor is collapsed).
  hiddenAncestors: Set<string>;
}

function flattenForRender(blocks: BlockType[], opts: FlattenOpts): { block: BlockType; depth: number; hasChildren: boolean }[] {
  const byId = new Map<string, BlockType>();
  const childrenOf = new Map<string | null, BlockType[]>();
  for (const b of blocks) {
    byId.set(b.id, b);
    const key = b.parent_id ?? null;
    const arr = childrenOf.get(key);
    if (arr) arr.push(b);
    else childrenOf.set(key, [b]);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.position - b.position);
  }

  const out: { block: BlockType; depth: number; hasChildren: boolean }[] = [];
  const walk = (parentId: string | null, depth: number, ancestorHidden: boolean) => {
    const siblings = childrenOf.get(parentId) || [];
    for (const b of siblings) {
      const kids = childrenOf.get(b.id) || [];
      const hasChildren = kids.length > 0;
      // If an ancestor is collapsed, the whole subtree is omitted.
      // If this block itself is collapsed, its direct children are omitted
      // (but the block itself still renders).
      const isHidden = ancestorHidden;
      const hideKids = isHidden || b.collapsed;
      if (!isHidden) {
        out.push({ block: b, depth, hasChildren });
      }
      if (hasChildren && !hideKids) {
        walk(b.id, depth + 1, isHidden);
      }
    }
  };
  walk(null, 0, false);
  // hiddenAncestors is kept on the signature for future use (search filters,
  // etc.). Today it's always an empty Set.
  void opts.hiddenAncestors;
  return out;
}

// Find the previous block in document order (any sibling or ancestor sibling,
// by position). Returns the previous block or null if first.
function previousBlock(blocks: BlockType[], id: string): BlockType | null {
  const idx = blocks.findIndex(b => b.id === id);
  if (idx <= 0) return null;
  return blocks[idx - 1];
}

// Is `maybeDescendant` a descendant of `ancestor` in the block tree? Used by
// drag & drop to reject drops that would create cycles (nesting a parent
// inside its own child).
function isDescendantOf(blocks: BlockType[], maybeDescendant: string, ancestor: string): boolean {
  let cur = blocks.find(b => b.id === maybeDescendant);
  let guard = 0;
  while (cur && guard++ < 64) {
    if (!cur.parent_id) return false;
    if (cur.parent_id === ancestor) return true;
    cur = blocks.find(b => b.id === cur!.parent_id);
  }
  return false;
}

// Find the new parent candidate for a block when Tab is pressed.
// Rules (markflare model):
//   - If the previous block is at level 0 (no parent), the new parent is that
//     previous block.
//   - If the previous block already has a parent, the new parent is the
//     previous block's parent (one level deeper — this is what markflare does).
// If there's no previous block, indent isn't possible.
function indentTarget(blocks: BlockType[], id: string): string | null {
  const prev = previousBlock(blocks, id);
  if (!prev) return null;
  return prev.id;
}

// Shift+Tab: find the new parent when dedenting. The block becomes a sibling
// of its current parent (just after it). If it has no parent, dedent is a no-op.
function dedentTarget(blocks: BlockType[], id: string): { newParentId: string | null; newPrev: BlockType | null } {
  const block = blocks.find(b => b.id === id);
  if (!block || !block.parent_id) return { newParentId: null, newPrev: null };
  const parent = blocks.find(b => b.id === block.parent_id);
  if (!parent) return { newParentId: null, newPrev: null };
  // Insert the block (and all its children) just after the parent, as its
  // sibling. The "previous" position is the parent's last child for ordering.
  const lastSiblingChild = blocks
    .filter(b => b.parent_id === parent.id)
    .sort((a, b) => b.position - a.position)[0];
  return { newParentId: parent.parent_id ?? null, newPrev: lastSiblingChild || parent };
}

export function BlockEditor({ pageId, initialBlocks }: Props) {
  const [blocks, setBlocks] = useState<BlockType[]>(() =>
    // Ensure new fields have defaults if the backend doesn't return them yet
    // (compatibility with un-migrated DBs).
    initialBlocks.map(b => ({
      ...b,
      parent_id: b.parent_id ?? null,
      collapsed: b.collapsed ?? false,
    }))
  );
  const [slashMenu, setSlashMenu] = useState<{
    visible: boolean;
    blockId: string | null;
    query: string;
    position: { top: number; left: number };
  }>({ visible: false, blockId: null, query: '', position: { top: 0, left: 0 } });

  const blockRefs = useRef<Record<string, HTMLElement>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadRef = useRef<{ id: string, type: BType } | null>(null);
  const updaterRef = useRef<ReturnType<typeof debounceWithFlush> | null>(null);

  // Load initialBlocks when page changes (also on first mount).
  useEffect(() => {
    setBlocks(initialBlocks.map(b => ({
      ...b,
      parent_id: b.parent_id ?? null,
      collapsed: b.collapsed ?? false,
    })));
    // Flush pending updates from the previous page.
    updaterRef.current?.flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // Debounced updater: created once per page. Flush on unmount or unload.
  useEffect(() => {
    const u = debounceWithFlush(async (id: string, data: any) => {
      try {
        await api.blocks.update(id, data);
      } catch (e) {
        console.error('Failed to update block', e);
      }
    }, 500);
    updaterRef.current = u;
    return () => {
      u.flush();
      updaterRef.current = null;
    };
  }, [pageId]);

  // Flush on tab close or page hidden.
  useEffect(() => {
    const onBeforeUnload = () => updaterRef.current?.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') updaterRef.current?.flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handleContentChange = (id: string, content: string) => {
    const block = blocks.find(b => b.id === id);
    if (!block) return;

    const match = content.match(/^\/(.*)$/);
    if (match || content === '/') {
      const el = blockRefs.current[id];
      if (el) {
        const rect = el.getBoundingClientRect();
        setSlashMenu({
          visible: true,
          blockId: id,
          query: match ? match[1] : '',
          position: { top: rect.bottom + window.scrollY, left: rect.left + window.scrollX }
        });
      }
    } else {
      setSlashMenu(prev => ({ ...prev, visible: false }));
    }

    setBlocks(prev => prev.map(b => b.id === id ? { ...b, content } : b));
    if (!id.startsWith('temp-')) {
      updaterRef.current?.debounced(id, { content });
    }
  };

  const handleCheckedChange = (id: string, checked: boolean) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, checked } : b));
    if (!id.startsWith('temp-')) {
      updaterRef.current?.debounced(id, { checked });
    }
  };

  const handleLanguageChange = (id: string, language: string) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, language } : b));
    if (!id.startsWith('temp-')) {
      updaterRef.current?.debounced(id, { language });
    }
  };

  const handleToggleCollapse = useCallback((id: string) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, collapsed: !b.collapsed } : b));
    const target = blocks.find(b => b.id === id);
    if (target && !id.startsWith('temp-')) {
      updaterRef.current?.debounced(id, { collapsed: !target.collapsed });
    }
  }, [blocks]);

  // Paste-to-multiple-blocks.
  // Decision:
  //   - Plain 1-line text without markdown markers → don't intervene; the
  //     browser inserts it as normal typing (onInput handles it).
  //   - Multi-line text or block-level markers (#, >, -, *, 1., fences,
  //     ---, ___, ***) → preventDefault and split with parseMarkdownToBlocks.
  //
  // Heuristic:
  //   - Has \n + at least one non-empty line, OR
  //   - Some line starts with a block-level marker (same as the parser).
  // Intentionally does NOT include `**` as a marker: pasting `**bold**` mid-
  // paragraph must stay as literal text, not trigger a split.
  //
  // Outcome:
  //   - The current block becomes the FIRST parsed block (type change applied
  //     if needed, via setBlocks + updaterRef).
  //   - If detectedTitle exists and the current block is empty → use the
  //     detected title as heading1 instead of the first parsed block.
  //   - Remaining parsed blocks are inserted AFTER the current block; their
  //     positions are distributed in the gap to the next sibling under the
  //     same parent (same idea as createBlock, but for N blocks).
  //   - Focus lands on the LAST new block, cursor at end.
  const looksLikeMarkdown = (text: string): boolean => {
    const lines = text.split('\n');
    const hasNewline = lines.length > 1;
    const hasNonEmptyLine = lines.some(l => l.trim().length > 0);
    // Block-level markers only. `**` is excluded (inline emphasis); `- `, `* `,
    // `1. ` require a trailing space so we don't accidentally match `**bold**`.
    const blockMarker = /^(#{1,3}\s|>\s|- |\* |\d+\.\s|```|---|___|\*\*\*)/m;
    return (hasNewline && hasNonEmptyLine) || blockMarker.test(text);
  };

  const handleBlockPaste = useCallback(async (
    e: React.ClipboardEvent,
    blockId: string,
    currentContent: string
  ) => {
    const text = e.clipboardData.getData('text/plain');
    // Empty paste → let the browser handle it (no-op).
    if (!text) return;
    // Plain text without markers → let the browser handle it.
    if (!looksLikeMarkdown(text)) return;

    e.preventDefault();

    const { blocks: parsed, detectedTitle } = parseMarkdownToBlocks(text, '');
    if (parsed.length === 0) return;

    const current = blocks.find(b => b.id === blockId);
    if (!current) return;

    const [first, ...rest] = parsed;

    // Decide the current block's new type/content.
    // Special case: empty block + detectedTitle → promote to heading1 with the
    // detected title (markflare-style: leading # becomes the page title).
    let newType: BType = first.type as BType;
    let newContent = first.content;
    if (currentContent === '' && detectedTitle) {
      newType = 'heading1';
      newContent = detectedTitle;
    }

    // Update the current block. If the type matches only the content changes
    // (same path as handleContentChange, but without triggering the slash
    // menu). Otherwise we update type + content together.
    if (newType === current.type) {
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, content: newContent } : b));
      if (!blockId.startsWith('temp-')) {
        updaterRef.current?.debounced(blockId, { content: newContent });
      }
    } else {
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, type: newType, content: newContent } : b));
      if (!blockId.startsWith('temp-')) {
        updaterRef.current?.debounced(blockId, { type: newType, content: newContent });
      }
    }

    // Only 1 parsed block → the current block already holds it all. Focus at
    // the end (the browser would have put it there after the paste).
    if (rest.length === 0) {
      setTimeout(() => {
        const el = blockRefs.current[blockId];
        if (el) {
          el.focus();
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }, 0);
      return;
    }

    // Compute positions for the new blocks: distribute evenly in the gap
    // between the current block and its next sibling under the same parent.
    // If no next sibling, use 1000 as a fictitious gap (same as createBlock
    // when appending to the end of a level).
    const parentId = current.parent_id;
    const sameParentSiblings = blocks.filter(b => b.parent_id === parentId);
    const currentIdx = sameParentSiblings.findIndex(b => b.id === blockId);
    const nextOriginalSibling = currentIdx >= 0 ? sameParentSiblings[currentIdx + 1] : null;
    const availableGap = nextOriginalSibling
      ? Math.max(1000, nextOriginalSibling.position - current.position)
      : 1000;
    const step = availableGap / (rest.length + 1);

    // Build temp blocks with positions already calculated — both API and local
    // state get the correct position, avoiding the legacy createBlock bug
    // where position started at 0.
    const tempBlocks: BlockType[] = rest.map((p, i) => {
      const newId = `temp-${crypto.randomUUID()}`;
      return {
        id: newId,
        page_id: pageId,
        type: p.type as BType,
        content: p.content,
        checked: p.checked || false,
        language: '',
        position: current.position + step * (i + 1),
        parent_id: parentId,
        collapsed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    // Insert all in one local-state pass.
    setBlocks(prev => [...prev, ...tempBlocks].sort((a, b) => a.position - b.position));

    // Persist in parallel (faster than sequential, takes advantage of batching).
    // The temp → real-id swap follows the createBlock pattern.
    const promises = tempBlocks.map(async (tempBlock) => {
      try {
        const res = await api.blocks.create(pageId, {
          type: tempBlock.type,
          content: tempBlock.content,
          position: tempBlock.position,
          parent_id: tempBlock.parent_id,
        });
        setBlocks(prev => prev.map(b => b.id === tempBlock.id ? res.block : b));
        if (blockRefs.current[tempBlock.id]) {
          blockRefs.current[res.block.id] = blockRefs.current[tempBlock.id];
          delete blockRefs.current[tempBlock.id];
        }
        return res.block.id;
      } catch (err) {
        console.error('Failed to create block from paste', err);
        return tempBlock.id;
      }
    });

    const realIds = await Promise.all(promises);

    // Focus the last new block, cursor at end.
    const lastTempId = tempBlocks[tempBlocks.length - 1].id;
    const lastRealId = realIds[realIds.length - 1];
    setTimeout(() => {
      // Prefer the real-id (already swapped) but fall back to temp-id if the
      // swap hasn't happened yet (e.g. the API call failed).
      const el = (lastRealId && blockRefs.current[lastRealId]) || blockRefs.current[lastTempId];
      if (el) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }, 0);
  }, [blocks, pageId]);

  const createBlock = async (
    afterId: string | null,
    type: BType = 'paragraph',
    content = '',
    parentId: string | null = null,
    language = ''
  ) => {
    const newId = `temp-${crypto.randomUUID()}`;
    const newBlock: BlockType = {
      id: newId,
      page_id: pageId,
      type,
      content,
      checked: false,
      language,
      position: 0,
      parent_id: parentId,
      collapsed: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Compute the position: if parentId is set, append to the end of that
    // parent's children; otherwise append to the root level (parent_id=null).
    let newPosition = 0;
    if (afterId) {
      const idx = blocks.findIndex(b => b.id === afterId);
      if (idx !== -1) {
        const siblingAfter = blocks[idx + 1];
        const prevPos = blocks[idx].position;
        const nextPos = siblingAfter && siblingAfter.parent_id === blocks[idx].parent_id
          ? siblingAfter.position
          : prevPos + 1000;
        newPosition = Math.floor((prevPos + nextPos) / 2);
      } else {
        newPosition = (blocks.length) * 1000;
      }
    } else {
      const lastRoot = [...blocks].reverse().find(b => b.parent_id === parentId);
      newPosition = lastRoot ? lastRoot.position + 1000 : 0;
    }

    setBlocks(prev => [...prev, newBlock].sort((a, b) => a.position - b.position));

    setTimeout(() => {
      const el = blockRefs.current[newId];
      if (el) el.focus();
    }, 0);

    try {
      const res = await api.blocks.create(pageId, { type, content, position: newPosition, parent_id: parentId, language });
      setBlocks(prev => prev.map(b => b.id === newId ? res.block : b));
      if (blockRefs.current[newId]) {
        blockRefs.current[res.block.id] = blockRefs.current[newId];
        delete blockRefs.current[newId];
      }
      return res.block;
    } catch (e) {
      console.error('Failed to create block', e);
      return null;
    }
  };

  const deleteBlock = async (
    id: string,
    direction: 'backspace' | 'menu' = 'menu',
  ) => {
    if (blocks.length <= 1) return;
    const idx = blocks.findIndex(b => b.id === id);
    if (idx === -1) return;

    // Blocks with children: remove the entire subtree.
    const toRemove = new Set<string>();
    const collect = (bid: string) => {
      toRemove.add(bid);
      for (const b of blocks) {
        if (b.parent_id === bid) collect(b.id);
      }
    };
    collect(id);

    // Pick a focus target: the previous visible block (not in toRemove),
    // or the next visible one.
    const prevVisible = (() => {
      for (let i = idx - 1; i >= 0; i--) {
        if (!toRemove.has(blocks[i].id)) return blocks[i];
      }
      return null;
    })();
    const nextVisible = (() => {
      for (let i = idx + 1; i < blocks.length; i++) {
        if (!toRemove.has(blocks[i].id)) return blocks[i];
      }
      return null;
    })();

    setBlocks(prev => prev.filter(b => !toRemove.has(b.id)));

    setTimeout(() => {
      // Focus direction:
      //   - 'backspace': the user is deleting "backwards", so focus goes to
      //     the NEXT visible block with the cursor at the START. If no next,
      //     fall back to the previous with cursor at the end.
      //   - 'menu' (default): deleted from the context menu — preserve the
      //     previous visible block with the cursor at the end; fall back to
      //     the next one.
      let target: BlockType | null = null;
      let collapseToStart = false;
      if (direction === 'backspace') {
        target = nextVisible ?? prevVisible;
        collapseToStart = target === nextVisible;
      } else {
        target = prevVisible ?? nextVisible;
        collapseToStart = false;
      }
      if (target && blockRefs.current[target.id]) {
        const el = blockRefs.current[target.id];
        el.focus();
        if (typeof window !== 'undefined' && window.getSelection) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(collapseToStart);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
    }, 0);

    // Delete in backend: only persisted blocks.
    for (const bid of toRemove) {
      if (!bid.startsWith('temp-')) {
        try {
          await api.blocks.delete(bid);
        } catch (e) {
          console.error('Failed to delete block', e);
        }
      }
    }
  };

  // Transform a block's type (e.g. paragraph → heading1) preserving its
  // content. Triggered from the block's context menu. Divider gets empty
  // content (a divider with text doesn't make sense). If the block is already
  // the target type, this is a no-op.
  const handleTransform = async (id: string, newType: BType) => {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
    if (block.type === newType) return;

    // Divider gets empty content; everything else preserves it
    // (e.g. heading1 → bullet_list keeps the text).
    const newContent = newType === 'divider' ? '' : block.content;

    // Optimistic update: local state first, then backend. If the request
    // fails the user still sees the local change; we log for debugging.
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, type: newType, content: newContent } : b));

    if (!id.startsWith('temp-')) {
      try {
        await api.blocks.update(id, { type: newType, content: newContent });
      } catch (e) {
        console.error('Failed to transform block', e);
      }
    }
  };

  const handleKeyDown = (id: string, e: React.KeyboardEvent) => {
    if (slashMenu.visible) return;

    const idx = blocks.findIndex(b => b.id === id);
    if (idx === -1) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // El nuevo bloque hereda el parent_id del actual. Si el padre del actual
      // está collapsed, lo expandemos automáticamente para que el usuario vea
      // el bloque que acaba de crear (markflare hace lo mismo).
      const current = blocks[idx];
      createBlock(id, 'paragraph', '', current.parent_id);
      if (current.parent_id) {
        const parent = blocks.find(b => b.id === current.parent_id);
        if (parent && parent.collapsed) {
          setBlocks(prev => prev.map(b => b.id === parent.id ? { ...b, collapsed: false } : b));
          if (!parent.id.startsWith('temp-')) {
            updaterRef.current?.debounced(parent.id, { collapsed: false });
          }
        }
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const current = blocks[idx];
      if (e.shiftKey) {
        // Shift+Tab: dedent. Already at root level → no-op.
        const { newParentId, newPrev } = dedentTarget(blocks, id);
        if (newPrev) {
          setBlocks(prev => prev.map(b => b.id === id ? { ...b, parent_id: newParentId } : b));
          // Reposition: just after newPrev on its level.
          const newPosition = (newPrev.position) + 500;
          setBlocks(prev => prev.map(b => b.id === id ? { ...b, position: newPosition } : b));
          if (!id.startsWith('temp-')) {
            updaterRef.current?.debounced(id, { parent_id: newParentId, position: newPosition });
          }
        }
      } else {
        // Tab: indent under the previous block.
        const newParentId = indentTarget(blocks, id);
        if (newParentId) {
          setBlocks(prev => prev.map(b => b.id === id ? { ...b, parent_id: newParentId } : b));
          // Position at the end of the new parent's children.
          const siblings = blocks.filter(b => b.parent_id === newParentId);
          const newPosition = (siblings.length > 0 ? Math.max(...siblings.map(s => s.position)) : 0) + 1000;
          setBlocks(prev => prev.map(b => b.id === id ? { ...b, position: newPosition } : b));
          // Auto-expand the parent if it's collapsed so the user sees the
          // newly nested block.
          setBlocks(prev => prev.map(b => b.id === newParentId ? { ...b, collapsed: false } : b));
          if (!id.startsWith('temp-')) {
            updaterRef.current?.debounced(id, { parent_id: newParentId, position: newPosition });
          }
          const parent = blocks.find(b => b.id === newParentId);
          if (parent && parent.collapsed) {
            updaterRef.current?.debounced(newParentId, { collapsed: false });
          }
        }
      }
      return;
    }

    if (e.key === 'Backspace') {
      const block = blocks[idx];
      const nonEditable = ['subpage', 'divider', 'image', 'file'].includes(block.type);
      if (nonEditable || block.content === '') {
        e.preventDefault();
        deleteBlock(id, 'backspace');
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      const el = blockRefs.current[id];
      const sel = window.getSelection();
      if (sel && sel.focusOffset === 0 && idx > 0) {
        e.preventDefault();
        blockRefs.current[blocks[idx - 1].id]?.focus();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      const el = blockRefs.current[id];
      const sel = window.getSelection();
      if (sel && sel.focusOffset === el.textContent?.length && idx < blocks.length - 1) {
        e.preventDefault();
        blockRefs.current[blocks[idx + 1].id]?.focus();
      }
      return;
    }
  };

  const { createPage, refreshPages } = usePageContext();

  const handleSlashSelect = async (type: BType) => {
    if (!slashMenu.blockId) return;
    const id = slashMenu.blockId;

    if (type === 'image' || type === 'file') {
      pendingUploadRef.current = { id, type };
      if (fileInputRef.current) fileInputRef.current.click();
      setSlashMenu(prev => ({ ...prev, visible: false }));
      return;
    }

    if (type === 'subpage') {
      setSlashMenu(prev => ({ ...prev, visible: false }));
      try {
        const newPage = await createPage(pageId);
        await refreshPages();
        const newContent = newPage.id;
        setBlocks(prev => prev.map(b => b.id === id ? { ...b, type: 'subpage', content: newContent } : b));
        if (!id.startsWith('temp-')) {
          updaterRef.current?.debounced(id, { type: 'subpage', content: newContent });
        }
      } catch (e) {
        console.error('Failed to create subpage block', e);
      }
      return;
    }

    if (type === 'table') {
      const defaultTable = {
        columns: ['Column 1', 'Column 2', 'Column 3'],
        rows: [['', '', ''], ['', '', ''], ['', '', '']],
      };
      const newContent = JSON.stringify(defaultTable);
      setBlocks(prev => prev.map(b => b.id === id ? { ...b, type: 'table', content: newContent } : b));
      if (!id.startsWith('temp-')) {
        updaterRef.current?.debounced(id, { type: 'table', content: newContent });
      }
      setSlashMenu(prev => ({ ...prev, visible: false }));
      return;
    }

    if (type === 'toggle') {
      // markflare model: creating a toggle = parent (paragraph with chevron) +
      // empty child. Cursor lands on the child so the user can type right away.
      setSlashMenu(prev => ({ ...prev, visible: false }));
      // 1. Convert the current block into the toggle "parent". We persist
      //    'paragraph' (no dedicated 'toggle' type in the backend); rendering
      //    treats both the same.
      setBlocks(prev => prev.map(b => b.id === id ? { ...b, type: 'paragraph', content: '' } : b));
      if (!id.startsWith('temp-')) {
        updaterRef.current?.debounced(id, { type: 'paragraph', content: '' });
      }
      // 2. Create the empty child with parent_id pointing at the parent.
      await createBlock(id, 'paragraph', '', id);
      return;
    }

    setBlocks(prev => prev.map(b => b.id === id ? { ...b, type, content: '' } : b));
    if (!id.startsWith('temp-')) {
      updaterRef.current?.debounced(id, { type, content: '' });
    }

    setSlashMenu(prev => ({ ...prev, visible: false }));

    setTimeout(() => {
      const el = blockRefs.current[id];
      if (el) el.focus();
    }, 0);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const pending = pendingUploadRef.current;
    if (!file || !pending) return;

    try {
      const res = await api.files.upload(file, pageId);
      const content = res.file.id;
      const language = pending.type === 'file' ? res.file.name : '';

      setBlocks(prev => prev.map(b =>
        b.id === pending.id
          ? { ...b, type: pending.type, content, language }
          : b
      ));

      if (!pending.id.startsWith('temp-')) {
        await api.blocks.update(pending.id, {
          type: pending.type,
          content,
          ...(language && { language })
        });
      }

      setTimeout(() => {
        const el = blockRefs.current[pending.id];
        if (el) el.focus();
      }, 0);
    } catch (err) {
      console.error('Upload failed', err);
    } finally {
      pendingUploadRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Drag & drop.
  // The drag source id lives in a ref so dragging doesn't trigger re-renders.
  // The drop indicator (top/middle/bottom) lives in state because CSS classes
  // paint it.
  const draggingIdRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'top' | 'middle' | 'bottom' } | null>(null);

  // Compute drop zone based on cursor Y relative to the target block.
  // First 25% = top, last 25% = bottom, rest = middle.
  const computeDropPosition = useCallback((targetId: string, clientY: number): 'top' | 'middle' | 'bottom' => {
    const el = document.getElementById(`block-${targetId}`) || blockRefs.current[targetId];
    if (!el) return 'bottom';
    const rect = el.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    if (ratio < 0.25) return 'top';
    if (ratio > 0.75) return 'bottom';
    return 'middle';
  }, []);

  // Compute the new (parentId, position) for the source block, given the
  // target block and the drop zone. Single source of truth used by both the
  // local-state update and the backend persistence.
  const computeDrop = useCallback((
    list: BlockType[],
    sourceId: string,
    targetId: string,
    pos: 'top' | 'middle' | 'bottom'
  ): { newParentId: string | null; newPosition: number } | null => {
    const source = list.find(b => b.id === sourceId);
    const target = list.find(b => b.id === targetId);
    if (!source || !target) return null;
    if (pos === 'middle' && isDescendantOf(list, targetId, sourceId)) return null;

    const newParentId = pos === 'middle' ? targetId : target.parent_id;
    const siblings = list.filter(b => b.parent_id === newParentId && b.id !== sourceId);
    let newPosition: number;
    if (pos === 'top') {
      const targetIdx = siblings.findIndex(b => b.id === targetId);
      const before = targetIdx > 0 ? siblings[targetIdx - 1] : null;
      const after = siblings[targetIdx];
      newPosition = before
        ? Math.floor((before.position + (after ? after.position : before.position + 1000)) / 2) || before.position + 500
        : (after ? after.position - 500 : 1000);
    } else if (pos === 'bottom') {
      const targetIdx = siblings.findIndex(b => b.id === targetId);
      const after = targetIdx >= 0 && targetIdx < siblings.length - 1 ? siblings[targetIdx + 1] : null;
      newPosition = after
        ? Math.floor((target.position + after.position) / 2) || target.position + 500
        : target.position + 1000;
    } else {
      const kids = list.filter(b => b.parent_id === targetId);
      newPosition = kids.length > 0 ? Math.max(...kids.map(k => k.position)) + 1000 : 1000;
    }
    return { newParentId, newPosition };
  }, []);

  const handleBlockDragStart = useCallback((id: string, e: React.DragEvent) => {
    draggingIdRef.current = id;
    // dataTransfer is required in Firefox for drop to fire.
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    }
  }, []);

  const handleBlockDragEnd = useCallback((_id: string) => {
    draggingIdRef.current = null;
    setDropTarget(null);
  }, []);

  const handleBlockDragOver = useCallback((id: string, e: React.DragEvent) => {
    if (!draggingIdRef.current || draggingIdRef.current === id) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    const pos = computeDropPosition(id, e.clientY);
    setDropTarget(prev => (prev?.id === id && prev.position === pos) ? prev : { id, position: pos });
  }, [computeDropPosition]);

  const handleBlockDragLeave = useCallback((_id: string) => {
    // We don't clear dropTarget here: when moving between blocks the leave
    // fires before the next over, which would leave a frame without an
    // indicator. The next block's over immediately overwrites it. We only
    // clear on dragEnd.
  }, []);

  // Apply the drop: recalculate parent_id + position of the dragged block.
  // Rules:
  //   - top:    same parent as target, position just before.
  //   - bottom: same parent as target, position just after.
  //   - middle: target becomes the new parent (nesting).
  const handleBlockDrop = useCallback(async (targetId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      let prevId = targetId;
      for (const file of files) {
        try {
          const isImg = file.type.startsWith('image/');
          const res = await api.files.upload(file, pageId);
          const newBlock = await createBlock(
            prevId,
            isImg ? 'image' : 'file',
            res.file.id,
            null,
            file.name
          );
          if (newBlock) prevId = newBlock.id;
        } catch (err) {
          console.error('Error uploading dropped file:', err);
        }
      }
      return;
    }

    const sourceId = draggingIdRef.current || e.dataTransfer?.getData('text/plain') || null;
    draggingIdRef.current = null;
    setDropTarget(null);
    if (!sourceId || sourceId === targetId) return;

    const pos = computeDropPosition(targetId, e.clientY);
    const computed = computeDrop(blocks, sourceId, targetId, pos);
    if (!computed) return;

    setBlocks(prev => {
      const target = prev.find(b => b.id === targetId)!;
      let next = prev.map(b => b.id === sourceId ? { ...b, parent_id: computed.newParentId, position: computed.newPosition } : b);
      // If the parent changed (we nested), auto-expand the target so the user
      // sees where the block landed.
      if (pos === 'middle' && target.collapsed) {
        next = next.map(b => b.id === targetId ? { ...b, collapsed: false } : b);
      }
      return next;
    });

    // Persist: one update per source (parent + position), plus the target's
    // collapsed reset if we nested into it.
    const sourceBlock = blocks.find(b => b.id === sourceId);
    if (sourceBlock && !sourceBlock.id.startsWith('temp-')) {
      updaterRef.current?.debounced(sourceId, { parent_id: computed.newParentId, position: computed.newPosition });
      const target = blocks.find(b => b.id === targetId);
      if (pos === 'middle' && target?.collapsed) {
        updaterRef.current?.debounced(targetId, { collapsed: false });
      }
    }
  }, [blocks, computeDrop, computeDropPosition]);

  const handleEditorDrop = async (e: React.DragEvent) => {
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      let prevId = blocks.length > 0 ? blocks[blocks.length - 1].id : null;
      for (const file of files) {
        try {
          const isImg = file.type.startsWith('image/');
          const res = await api.files.upload(file, pageId);
          const newBlock = await createBlock(
            prevId,
            isImg ? 'image' : 'file',
            res.file.id,
            null,
            file.name
          );
          if (newBlock) prevId = newBlock.id;
        } catch (err) {
          console.error('Error uploading dropped file:', err);
        }
      }
    }
  };

  const handleEditorPaste = async (e: React.ClipboardEvent) => {
    if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
      const files = Array.from(e.clipboardData.files);
      const hasFiles = files.some(f => f.type.startsWith('image/') || f.size > 0);
      if (hasFiles) {
        e.preventDefault();
        let prevId = blocks.length > 0 ? blocks[blocks.length - 1].id : null;
        for (const file of files) {
          try {
            const isImg = file.type.startsWith('image/');
            const res = await api.files.upload(file, pageId);
            const newBlock = await createBlock(
              prevId,
              isImg ? 'image' : 'file',
              res.file.id,
              null,
              file.name || (isImg ? 'image.png' : 'file')
            );
            if (newBlock) prevId = newBlock.id;
          } catch (err) {
            console.error('Error uploading pasted file:', err);
          }
        }
      }
    }
  };

  // Flat render: every block in tree order with its depth and "has children" flag.
  // CSS indents using block-wrapper--depth-N.
  const flatRender = useMemo(
    () => flattenForRender(blocks, { hiddenAncestors: new Set() }),
    [blocks]
  );

  return (
    <div
      className="block-editor"
      onDrop={handleEditorDrop}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files') || draggingIdRef.current) {
          e.preventDefault();
        }
      }}
      onPaste={handleEditorPaste}
    >
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {blocks.length === 0 && (
        <button className="add-block-btn" onClick={() => createBlock(null)}>
          + Start writing...
        </button>
      )}
      {flatRender.map(({ block, depth, hasChildren }) => (
        <Block
          key={block.id}
          block={block}
          depth={depth}
          hasChildren={hasChildren}
          onToggleCollapse={handleToggleCollapse}
          onDragStart={handleBlockDragStart}
          onDragEnd={handleBlockDragEnd}
          onDragOver={handleBlockDragOver}
          onDragLeave={handleBlockDragLeave}
          onDrop={handleBlockDrop}
          dropIndicator={dropTarget?.id === block.id ? dropTarget.position : null}
          isOnly={blocks.length === 1}
          onContentChange={handleContentChange}
          onCheckedChange={handleCheckedChange}
          onLanguageChange={handleLanguageChange}
          onKeyDown={handleKeyDown}
          onDelete={deleteBlock}
          onTransform={handleTransform}
          onPaste={handleBlockPaste}
          blockRef={el => {
            if (el) blockRefs.current[block.id] = el;
            else delete blockRefs.current[block.id];
          }}
        />
      ))}
      {blocks.length > 0 && (
        <button className="add-block-btn" onClick={() => createBlock(blocks[blocks.length - 1].id)}>
          + Type something or press / for commands
        </button>
      )}

      {slashMenu.visible && (
        <SlashMenu
          position={slashMenu.position}
          query={slashMenu.query}
          onSelect={handleSlashSelect}
          onClose={() => setSlashMenu(prev => ({ ...prev, visible: false }))}
        />
      )}
    </div>
  );
}
