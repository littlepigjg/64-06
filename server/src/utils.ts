import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getDirSize(dirPath: string): number {
  let totalSize = 0;
  if (!fs.existsSync(dirPath)) return 0;
  
  function walk(currentPath: string) {
    const stats = fs.statSync(currentPath);
    if (stats.isFile()) {
      totalSize += stats.size;
    } else if (stats.isDirectory()) {
      const files = fs.readdirSync(currentPath);
      for (const file of files) {
        walk(path.join(currentPath, file));
      }
    }
  }
  
  walk(dirPath);
  return totalSize;
}

export function formatDate(ts: number): string {
  return new Date(ts).toISOString().split('T')[0];
}

export function formatLocalDate(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getLocalDateBeforeDays(days: number, fromTs: number = Date.now()): string {
  const d = new Date(fromTs);
  d.setDate(d.getDate() - days);
  return formatLocalDate(d.getTime());
}

export function getDaysInPeriod(period: 'day' | 'week' | 'month'): number {
  switch (period) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'month':
      return 30;
  }
}

export interface DateRangeForPeriod {
  start: string;
  prevStart: string;
  prevEnd: string;
  days: number;
}

export function getLocalDateRangeForPeriod(
  period: 'day' | 'week' | 'month'
): DateRangeForPeriod {
  const now = Date.now();
  const today = formatLocalDate(now);
  const days = getDaysInPeriod(period);

  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - days + 1);
  const start = formatLocalDate(periodStart.getTime());

  const prevPeriodEnd = new Date(periodStart);
  prevPeriodEnd.setDate(prevPeriodEnd.getDate() - 1);
  const prevEnd = formatLocalDate(prevPeriodEnd.getTime());

  const prevPeriodStart = new Date(prevPeriodEnd);
  prevPeriodStart.setDate(prevPeriodStart.getDate() - days + 1);
  const prevStart = formatLocalDate(prevPeriodStart.getTime());

  return { start, prevStart, prevEnd, days };
}

export function getDailyDownloadsLocal(
  packageId: number,
  days: number,
  downloadHistory: Array<{ packageId: number; date: string; count: number }>
): Array<{ date: string; count: number }> {
  const result: Array<{ date: string; count: number }> = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = formatLocalDate(d.getTime());
    const record = downloadHistory.find(
      (h) => h.packageId === packageId && h.date === dateStr
    );
    result.push({
      date: dateStr,
      count: record?.count || 0,
    });
  }
  return result;
}

export function parseNpmPackageName(name: string): { scope?: string; name: string } {
  if (name.startsWith('@')) {
    const parts = name.split('/');
    return {
      scope: parts[0],
      name: parts.slice(1).join('/') || name,
    };
  }
  return { name };
}

export function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9@._\-/]/g, '_').replace(/\.\./g, '_');
}
