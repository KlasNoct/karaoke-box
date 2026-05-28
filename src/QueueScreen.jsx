import { useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// useLongPress — fires onLongPress after `delay`ms, otherwise fires onPress
// ---------------------------------------------------------------------------
function useLongPress(onPress, onLongPress, delay = 500) {
  const timer = useRef(null);
  const fired = useRef(false);

  const start = useCallback(
    (e) => {
      // Don't hijack right-click
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      fired.current = false;
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, delay);
    },
    [onLongPress, delay]
  );

  const end = useCallback(() => {
    clearTimeout(timer.current);
    if (!fired.current) onPress();
  }, [onPress]);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
  }, []);

  return {
    onMouseDown: start,
    onMouseUp: end,
    onMouseLeave: cancel,
    onTouchStart: start,
    onTouchEnd: end,
    onTouchCancel: cancel,
  };
}

// ---------------------------------------------------------------------------
// ArrowButton — 44px touch target, long-press sends to top/bottom
// ---------------------------------------------------------------------------
function ArrowButton({ direction, disabled, onPress, onLongPress }) {
  const handlers = useLongPress(onPress, onLongPress);
  const label =
    direction === 'up'
      ? 'Move up — hold to move to top'
      : 'Move down — hold to move to bottom';

  return (
    <button
      {...(disabled ? {} : handlers)}
      disabled={disabled}
      aria-label={label}
      style={{
        width: 44,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'none',
        border: 'none',
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.2 : 0.7,
        fontSize: 16,
        color: 'inherit',
        flexShrink: 0,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'manipulation',
        transition: 'opacity 0.15s',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={e => { if (!disabled) e.currentTarget.style.opacity = '0.7'; }}
    >
      {direction === 'up' ? '↑' : '↓'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// QueueScreen
// ---------------------------------------------------------------------------
// Props:
//   queue          — array of song objects (upcoming, not including now-playing)
//   currentSong    — song object currently playing, or null
//   onPlay         — () => void  — start playing first in queue
//   onRemove       — (index) => void
//   onMoveUp       — (index) => void  — swap with index-1
//   onMoveDown     — (index) => void  — swap with index+1
//   onMoveToTop    — (index) => void
//   onMoveToBottom — (index) => void
//   onShuffle      — () => void
//   onClear        — () => void
//   onGoToLibrary  — () => void
// ---------------------------------------------------------------------------
export default function QueueScreen({
  queue,
  currentSong,
  onPlay,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onMoveToBottom,
  onShuffle,
  onClear,
  onGoToLibrary,
}) {
  const hasQueue = queue.length > 0;
  const nothingPlaying = !currentSong;
  const canPlay = hasQueue && nothingPlaying;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid var(--border, rgba(255,255,255,0.1))',
          flexShrink: 0,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>
          Queue
        </h2>
        {hasQueue && (
          <p
            style={{
              margin: '3px 0 0',
              fontSize: 13,
              color: 'var(--text-secondary, rgba(255,255,255,0.5))',
            }}
          >
            {queue.length} song{queue.length !== 1 ? 's' : ''} up next
          </p>
        )}
      </div>

      {/* ── Now Playing ── */}
      {currentSong && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.1))',
            background: 'var(--surface-raised, rgba(255,255,255,0.04))',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontWeight: 700,
              color: 'var(--accent, #f97316)',
              marginBottom: 4,
            }}
          >
            ♪ Now Playing
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {currentSong.title}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-secondary, rgba(255,255,255,0.5))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {currentSong.artist}
          </div>
        </div>
      )}

      {/* ── Queue list ── */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        {hasQueue ? (
          queue.map((song, i) => (
            <div
              key={`${song.id}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 4px 4px 16px',
                gap: 4,
                minHeight: 60,
                borderBottom: '1px solid var(--border, rgba(255,255,255,0.06))',
              }}
            >
              {/* Position number */}
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary, rgba(255,255,255,0.3))',
                  width: 20,
                  flexShrink: 0,
                  textAlign: 'right',
                  marginRight: 10,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {i + 1}
              </span>

              {/* Song info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.3,
                  }}
                >
                  {song.title}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.3,
                  }}
                >
                  {song.artist}
                </div>
              </div>

              {/* Controls */}
              <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <ArrowButton
                  direction="up"
                  disabled={i === 0}
                  onPress={() => onMoveUp(i)}
                  onLongPress={() => onMoveToTop(i)}
                />
                <ArrowButton
                  direction="down"
                  disabled={i === queue.length - 1}
                  onPress={() => onMoveDown(i)}
                  onLongPress={() => onMoveToBottom(i)}
                />
                <button
                  onClick={() => onRemove(i)}
                  aria-label="Remove from queue"
                  style={{
                    width: 44,
                    height: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'none',
                    border: 'none',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 20,
                    lineHeight: 1,
                    color: 'var(--text-secondary, rgba(255,255,255,0.4))',
                    flexShrink: 0,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--text, #fff)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary, rgba(255,255,255,0.4))'; }}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        ) : (
          /* ── Empty state ── */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              minHeight: 300,
              padding: '40px 32px',
              textAlign: 'center',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 44, lineHeight: 1 }}>🎤</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>Queue is empty</div>
            <div
              style={{
                fontSize: 14,
                color: 'var(--text-secondary, rgba(255,255,255,0.5))',
                maxWidth: 220,
                lineHeight: 1.5,
              }}
            >
              Tap any song in the Library to add it here
            </div>
            <button
              onClick={onGoToLibrary}
              style={{
                marginTop: 8,
                padding: '11px 24px',
                background: 'var(--accent, #f97316)',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                cursor: 'pointer',
                letterSpacing: '0.01em',
              }}
            >
              Go to Library →
            </button>
          </div>
        )}
      </div>

      {/* ── Footer actions ── */}
      {hasQueue && (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border, rgba(255,255,255,0.1))',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {/* Play button — only when nothing is playing */}
          {canPlay && (
            <button
              onClick={onPlay}
              style={{
                flex: 1,
                padding: '13px 0',
                background: 'var(--accent, #f97316)',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                cursor: 'pointer',
                letterSpacing: '0.01em',
              }}
            >
              ▶ Play
            </button>
          )}

          <button
            onClick={onShuffle}
            title="Shuffle queue"
            style={{
              flex: canPlay ? '0 0 auto' : 1,
              padding: '13px 20px',
              background: 'var(--surface-raised, rgba(255,255,255,0.07))',
              border: '1px solid var(--border, rgba(255,255,255,0.12))',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              color: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            ⇌ Shuffle
          </button>

          <button
            onClick={onClear}
            title="Clear queue"
            style={{
              flex: '0 0 auto',
              padding: '13px 16px',
              background: 'none',
              border: '1px solid var(--border, rgba(255,255,255,0.12))',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
              color: 'var(--text-secondary, rgba(255,255,255,0.5))',
              whiteSpace: 'nowrap',
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
