import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAppStore } from "@/store/app";
import { parseTimeToMinutes, todayDateString } from "@/lib/dates";
import type { Task } from "@/types";
import { AppIcon } from "@/components/AppIcon";
import { isActiveTask } from "@/lib/tasks";

const HOUR_START = 6;
const HOUR_END = 24;
const MINUTE_STEP = 15;
const PIXELS_PER_MINUTE = 1.15;
const DEFAULT_DURATION = 30;
const MIN_DURATION = 15;
const COLLAPSE_KEY = "minimal.timelineCollapsed";
const POSITION_KEY = "minimal.timelineRailPositions";
const RAIL_MARGIN = 12;
const RAIL_TOP_SAFE = 52;
const RAIL_BOTTOM_SAFE = 76;

type RailPosition = { x: number; y: number };
type RailPositions = { collapsed?: RailPosition; open?: RailPosition };
type InteractionMode = "move" | "resize-start" | "resize-end";
type PreviewRange = { id: string; start: number; end: number };
type Interaction = PreviewRange & {
  mode: InteractionMode;
  originY: number;
  fromTray: boolean;
  moved: boolean;
  insideTimeline: boolean;
};
type RailDrag = {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

type LaidOut = {
  task: Task;
  startMin: number;
  endMin: number;
  lane: number;
};

function defaultRailPosition(collapsed: boolean): RailPosition {
  return {
    x: Math.max(RAIL_MARGIN, window.innerWidth - 150),
    y: collapsed
      ? Math.max(RAIL_TOP_SAFE, window.innerHeight - RAIL_BOTTOM_SAFE)
      : 72,
  };
}

function clampRailPosition(
  position: RailPosition,
  width: number,
  height: number,
): RailPosition {
  return {
    x: Math.max(
      RAIL_MARGIN,
      Math.min(window.innerWidth - width - RAIL_MARGIN, position.x),
    ),
    y: Math.max(
      RAIL_TOP_SAFE,
      Math.min(window.innerHeight - height - RAIL_BOTTOM_SAFE, position.y),
    ),
  };
}

function snapMinute(value: number) {
  return Math.round(value / MINUTE_STEP) * MINUTE_STEP;
}

function clampMinute(
  value: number,
  minimum = HOUR_START * 60,
  maximum = HOUR_END * 60,
) {
  return Math.max(minimum, Math.min(maximum, value));
}

function minuteToTime(value: number) {
  const minutes = clampMinute(value);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function formatRange(start?: string | null, end?: string | null) {
  if (!start && !end) return "未安排";
  if (start && end) return `${start}–${end}`;
  return start ?? end ?? "未安排";
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function rangeForTask(task: Task, preview: PreviewRange | null): [number, number] {
  if (preview?.id === task.id) return [preview.start, preview.end];
  const start = parseTimeToMinutes(task.due_time) ?? HOUR_START * 60;
  const end = Math.max(
    start + MIN_DURATION,
    parseTimeToMinutes(task.end_time) ??
      start + (task.estimated_minutes ?? DEFAULT_DURATION),
  );
  return [start, Math.min(HOUR_END * 60, end)];
}

function layoutRows(tasks: Task[], preview: PreviewRange | null) {
  const timed = tasks
    .map((task) => {
      const [startMin, endMin] = rangeForTask(task, preview);
      return { task, startMin, endMin };
    })
    .sort(
      (a, b) =>
        a.startMin - b.startMin ||
        a.endMin - b.endMin ||
        a.task.sort_order - b.task.sort_order,
    );

  const laneEnds: number[] = [];
  const items: LaidOut[] = timed.map((event) => {
    let lane = laneEnds.findIndex((end) => end <= event.startMin);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = event.endMin;
    return { ...event, lane };
  });

  return { items, laneCount: Math.max(1, laneEnds.length) };
}

function pointerMinute(
  event: ReactPointerEvent,
  scroll: HTMLDivElement | null,
) {
  if (!scroll) return HOUR_START * 60;
  const rect = scroll.getBoundingClientRect();
  return clampMinute(
    snapMinute(
      HOUR_START * 60 +
        (event.clientY - rect.top + scroll.scrollTop) / PIXELS_PER_MINUTE,
    ),
  );
}

export function TodayTimeline() {
  const tasks = useAppStore((s) => s.tasks);
  const selectTask = useAppStore((s) => s.selectTask);
  const addTask = useAppStore((s) => s.addTask);
  const saveTask = useAppStore((s) => s.saveTask);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const setToast = useAppStore((s) => s.setToast);
  const today = todayDateString();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [hoveredTask, setHoveredTask] = useState<{
    task: Task;
    range: string;
    x: number;
    y: number;
  } | null>(null);
  const [preview, setPreview] = useState<PreviewRange | null>(null);
  const [railPositions, setRailPositions] = useState<RailPositions>(() => {
    try {
      return JSON.parse(localStorage.getItem(POSITION_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<Interaction | null>(null);
  const railDragRef = useRef<RailDrag | null>(null);
  const suppressClickRef = useRef(false);

  const railMode = collapsed ? "collapsed" : "open";
  const storedRailPosition =
    railPositions[railMode] ?? defaultRailPosition(collapsed);
  const railPosition = clampRailPosition(
    storedRailPosition,
    railRef.current?.offsetWidth ?? 120,
    railRef.current?.offsetHeight ?? 40,
  );

  useEffect(() => {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(railPositions));
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.timeline = collapsed
      ? "collapsed"
      : "expanded";
    return () => {
      delete document.documentElement.dataset.timeline;
    };
  }, [collapsed, railPositions]);

  const todayTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          !task.parent_id &&
          !task.deleted_at &&
          isActiveTask(task) &&
          (task.my_day_date === today ||
            task.due_date === today ||
            (task.due_date !== null && task.due_date < today)),
      ),
    [tasks, today],
  );
  const unscheduledTasks = todayTasks.filter(
    (task) => !task.due_time && preview?.id !== task.id,
  );
  const scheduledTasks = todayTasks.filter(
    (task) => Boolean(task.due_time) || preview?.id === task.id,
  );
  const { items, laneCount } = useMemo(
    () => layoutRows(scheduledTasks, preview),
    [preview, scheduledTasks],
  );
  const axisHeight = (HOUR_END - HOUR_START) * 60 * PIXELS_PER_MINUTE;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMin - HOUR_START * 60) * PIXELS_PER_MINUTE;
  const firstTaskId = items[0]?.task.id ?? null;
  const highlightTaskId = selectedTaskId ?? firstTaskId;

  const moveRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railDragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    const width = railRef.current?.offsetWidth ?? 120;
    const height = railRef.current?.offsetHeight ?? 40;
    setRailPositions((current) => ({
      ...current,
      [railMode]: clampRailPosition(
        { x: drag.originX + dx, y: drag.originY + dy },
        width,
        height,
      ),
    }));
  };

  const startRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    railDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: railPosition.x,
      originY: railPosition.y,
      moved: false,
    };
  };

  const finishRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railDragRef.current;
    railDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    if (drag && !drag.moved) setCollapsed((value) => !value);
  };

  const startTaskInteraction = (
    event: ReactPointerEvent<HTMLElement>,
    task: Task,
    mode: InteractionMode,
    fromTray = false,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = parseTimeToMinutes(task.due_time) ?? HOUR_START * 60;
    const end = Math.min(
      HOUR_END * 60,
      Math.max(
        start + MIN_DURATION,
        parseTimeToMinutes(task.end_time) ??
          start + (task.estimated_minutes ?? DEFAULT_DURATION),
      ),
    );
    dragRef.current = {
      id: task.id,
      mode,
      originY: event.clientY,
      start,
      end,
      fromTray,
      moved: false,
      insideTimeline: !fromTray,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveTaskInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const scroll = scrollRef.current;
    const rect = scroll?.getBoundingClientRect();
    const inside = Boolean(
      rect && event.clientY >= rect.top && event.clientY <= rect.bottom,
    );
    drag.insideTimeline ||= inside;
    const delta = snapMinute(
      (event.clientY - drag.originY) / PIXELS_PER_MINUTE,
    );
    let start = drag.start;
    let end = drag.end;
    if (drag.fromTray) {
      if (!inside) return;
      start = pointerMinute(event, scroll);
      end = Math.min(HOUR_END * 60, start + drag.end - drag.start);
    } else if (drag.mode === "move") {
      start = clampMinute(drag.start + delta);
      end = clampMinute(drag.end + delta);
      if (end === HOUR_END * 60) start = end - (drag.end - drag.start);
    } else if (drag.mode === "resize-start") {
      start = Math.min(clampMinute(drag.start + delta), drag.end - MIN_DURATION);
    } else {
      end = Math.max(drag.start + MIN_DURATION, clampMinute(drag.end + delta));
    }
    drag.moved ||= Math.abs(event.clientY - drag.originY) > 4;
    setPreview({ id: drag.id, start, end });
  };

  const finishTaskInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    const range =
      preview?.id === drag.id
        ? preview
        : { id: drag.id, start: drag.start, end: drag.end };
    setPreview(null);
    if (!drag.moved) {
      selectTask(drag.id);
      return;
    }
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (drag.fromTray && !drag.insideTimeline) return;
    void saveTask(drag.id, {
      my_day_date: today,
      due_time: minuteToTime(range.start),
      end_time: minuteToTime(range.end),
    }).then(() =>
      setToast(`已安排到 ${minuteToTime(range.start)}–${minuteToTime(range.end)}`),
    );
  };

  const openTaskDetail = (taskId: string) => {
    if (suppressClickRef.current) return;
    setHoveredTask(null);
    selectTask(taskId);
    setCollapsed(true);
  };

  const showTaskPreview = (
    event: { currentTarget: HTMLElement },
    task: Task,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoveredTask({
      task,
      range: formatRange(task.due_time, task.end_time),
      x: Math.min(window.innerWidth - 304, Math.max(12, rect.right + 10)),
      y: Math.min(window.innerHeight - 170, Math.max(12, rect.top)),
    });
  };

  return (
    <>
      {!collapsed ? (
        <button
          type="button"
          className="timeline-drawer-backdrop"
          aria-label="关闭时间轴"
          onClick={() => setCollapsed(true)}
        />
      ) : null}

      <aside
        className={`timeline-drawer ${collapsed ? "is-collapsed" : "is-open"}`}
        aria-hidden={collapsed}
      >
        <button
          ref={railRef}
          type="button"
          className="timeline-drawer-rail"
          title={collapsed ? "展开时间轴" : "收起时间轴"}
          aria-label={collapsed ? "展开时间轴" : "收起时间轴"}
          aria-expanded={!collapsed}
          style={{
            position: "fixed",
            left: railPosition.x,
            top: railPosition.y,
            right: "auto",
            bottom: "auto",
          }}
          onPointerDown={startRailDrag}
          onPointerMove={moveRail}
          onPointerUp={finishRailDrag}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setCollapsed((value) => !value);
            }
          }}
        >
          <AppIcon name="timer" size={17} />
          <span className="timeline-drawer-rail-label">
            {collapsed ? "今日时间轴" : "收起"}
          </span>
        </button>

        {!collapsed ? (
          <div className="timeline-drawer-panel">
            <div className="timeline-dock-head">
              <div className="timeline-dock-title">
                <div>
                  <span>拖动安排 · 15 分钟吸附</span>
                  <h3>今日时间轴</h3>
                </div>
                <span className="nav-count">{todayTasks.length}</span>
              </div>
              <input
                className="field timeline-quick-add"
                placeholder="+ 添加待办，回车后拖到时间轴"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const input = event.currentTarget;
                  const title = input.value.trim();
                  if (!title) return;
                  void addTask({
                    title,
                    due_date: today,
                    my_day_date: today,
                    due_time: null,
                    end_time: null,
                  });
                  input.value = "";
                }}
              />
            </div>

            {unscheduledTasks.length ? (
              <div className="timeline-unscheduled">
                <div className="timeline-unscheduled-head">
                  <strong>待安排</strong>
                  <span>把任务拖到下面的时间轴</span>
                </div>
                <div className="timeline-unscheduled-list">
                  {unscheduledTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className="timeline-unscheduled-task"
                      onPointerDown={(event) =>
                        startTaskInteraction(event, task, "move", true)
                      }
                      onPointerMove={moveTaskInteraction}
                      onPointerUp={finishTaskInteraction}
                      onClick={() => {
                        if (!suppressClickRef.current) selectTask(task.id);
                      }}
                    >
                      <span className={`timeline-task-dot p${task.priority}`} />
                      <span>{task.title}</span>
                      {task.estimated_minutes ? (
                        <small>{task.estimated_minutes} 分钟</small>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="timeline-dock-body timeline-v-body">
              <div className="timeline-v-scroll" ref={scrollRef}>
                <div className="timeline-v-canvas" style={{ height: axisHeight }}>
                  <div className="timeline-v-labels" aria-hidden="true">
                    {Array.from(
                      { length: HOUR_END - HOUR_START + 1 },
                      (_, index) => {
                        const hour = HOUR_START + index;
                        return (
                          <span
                            key={hour}
                            style={{
                              top: index * 60 * PIXELS_PER_MINUTE - 8,
                            }}
                          >
                            {hour === 24
                              ? "24:00"
                              : `${String(hour).padStart(2, "0")}:00`}
                          </span>
                        );
                      },
                    )}
                  </div>
                  <div className="timeline-v-grid" aria-hidden="true">
                    {Array.from(
                      { length: (HOUR_END - HOUR_START) * 4 + 1 },
                      (_, index) => {
                        const minute = index * MINUTE_STEP;
                        return (
                          <span
                            key={minute}
                            className={
                              minute % 60 === 0
                                ? "is-hour"
                                : minute % 30 === 0
                                  ? "is-half"
                                  : ""
                            }
                            style={{
                              top: minute * PIXELS_PER_MINUTE,
                            }}
                          />
                        );
                      },
                    )}
                    {nowMin >= HOUR_START * 60 && nowMin <= HOUR_END * 60 ? (
                      <i
                        className="timeline-v-now"
                        style={{ top: nowTop }}
                      />
                    ) : null}
                  </div>
                  <div className="timeline-v-events">
                    {items.map(({ task, startMin, endMin, lane }) => {
                      const duration = endMin - startMin;
                      const range = formatRange(task.due_time, task.end_time);
                      const effectiveStart =
                        preview?.id === task.id ? preview.start : startMin;
                      const effectiveEnd =
                        preview?.id === task.id ? preview.end : endMin;
                      const effectiveDuration = effectiveEnd - effectiveStart;
                      return (
                        <button
                          key={task.id}
                          type="button"
                          className={`timeline-v-event p${task.priority} ${highlightTaskId === task.id ? "is-focus" : ""} ${preview?.id === task.id ? "is-dragging" : ""}`}
                          style={{
                            top:
                              (effectiveStart - HOUR_START * 60) *
                              PIXELS_PER_MINUTE,
                            height: Math.max(
                              32,
                              effectiveDuration * PIXELS_PER_MINUTE,
                            ),
                            left: `calc(${(lane / laneCount) * 100}% + 4px)`,
                            width: `calc(${100 / laneCount}% - 8px)`,
                          }}
                          aria-label={`${task.title} ${range}`}
                          onPointerDown={(event) =>
                            startTaskInteraction(event, task, "move")
                          }
                          onPointerMove={moveTaskInteraction}
                          onPointerUp={finishTaskInteraction}
                          onMouseEnter={(event) =>
                            showTaskPreview(event, task)
                          }
                          onMouseLeave={() => setHoveredTask(null)}
                          onClick={() => openTaskDetail(task.id)}
                        >
                          <span
                            className="timeline-v-resize-handle is-start"
                            aria-label="调整开始时间"
                            onPointerDown={(event) =>
                              startTaskInteraction(event, task, "resize-start")
                            }
                          />
                          <span className="timeline-v-event-copy">
                            <strong>{task.title}</strong>
                            <small>
                              {preview?.id === task.id
                                ? `${minuteToTime(effectiveStart)}–${minuteToTime(effectiveEnd)}`
                                : range}
                            </small>
                            {duration >= 30 ? (
                              <em>{formatDuration(effectiveDuration)}</em>
                            ) : null}
                          </span>
                          <span
                            className="timeline-v-resize-handle is-end"
                            aria-label="调整结束时间"
                            onPointerDown={(event) =>
                              startTaskInteraction(event, task, "resize-end")
                            }
                          />
                        </button>
                      );
                    })}
                    {!items.length ? (
                      <div className="timeline-v-empty">拖动上方任务到这里</div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      {hoveredTask && !collapsed ? (
        <div
          className="timeline-task-popover"
          style={{ left: hoveredTask.x, top: hoveredTask.y }}
          role="tooltip"
        >
          <div className="timeline-task-popover-head">
            <strong>{hoveredTask.task.title}</strong>
            <span className={`timeline-task-priority p${hoveredTask.task.priority}`}>
              P{hoveredTask.task.priority}
            </span>
          </div>
          <div className="timeline-task-popover-meta">
            <span>
              <AppIcon name="timer" size={14} />
              {hoveredTask.range}
            </span>
            <span>
              {hoveredTask.task.status === "in_progress" ? "进行中" : "待处理"}
            </span>
            {hoveredTask.task.estimated_minutes ? (
              <span>预计 {hoveredTask.task.estimated_minutes} 分钟</span>
            ) : null}
          </div>
          {hoveredTask.task.description || hoveredTask.task.notes ? (
            <p>{hoveredTask.task.description || hoveredTask.task.notes}</p>
          ) : (
            <p className="is-muted">拖动色块调整时间，点击打开完整详情</p>
          )}
        </div>
      ) : null}
    </>
  );
}
