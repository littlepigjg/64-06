import fs from 'fs';
import path from 'path';
import {
  ensureDir,
  formatDate,
  getDirSize,
  formatLocalDate,
  getLocalDateBeforeDays,
  getLocalDateRangeForPeriod,
  getDailyDownloadsLocal,
  getDaysInPeriod,
} from '../../utils';
import { config } from '../../config';
import type { PackageInfo, PackageVersion, CacheStats, StorageTrend, CachePolicy, RegistryType, PackageSource, TrendPeriod, PackageRankingItem, DailyDownload } from '../../types';

interface DBPackage {
  id: number;
  name: string;
  registry: RegistryType;
  source: PackageSource;
  scope?: string;
  description?: string;
  author?: string;
  license?: string;
  latestVersion: string;
  createdAt: number;
  updatedAt: number;
  totalSize: number;
  downloadCount: number;
  lastAccessedAt: number;
}

interface DBVersion {
  id: number;
  packageId: number;
  version: string;
  size: number;
  filePath: string;
  sha1?: string;
  publishedAt: number;
  downloadCount: number;
}

interface DBDownloadHistory {
  packageId: number;
  date: string;
  count: number;
}

interface DB {
  nextPackageId: number;
  nextVersionId: number;
  packages: DBPackage[];
  versions: DBVersion[];
  storageTrend: StorageTrend[];
  cachePolicy: CachePolicy;
  downloadHistory: DBDownloadHistory[];
}

const DEFAULT_POLICY: CachePolicy = {
  maxSizeGB: 50,
  maxAgeDays: 90,
  autoClean: true,
};

export class MetadataIndex {
  private dataDir: string;
  private dbPath: string;
  private db: DB;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    ensureDir(dataDir);
    this.dbPath = path.join(dataDir, 'registry-data.json');
    this.db = this.loadDB();
  }

  private loadDB(): DB {
    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const packages: DBPackage[] = (parsed.packages || []).map((p: any) => ({
          ...p,
          lastAccessedAt: p.lastAccessedAt || p.updatedAt || 0,
        }));
        return {
          nextPackageId: parsed.nextPackageId || 1,
          nextVersionId: parsed.nextVersionId || 1,
          packages,
          versions: parsed.versions || [],
          storageTrend: parsed.storageTrend || [],
          cachePolicy: parsed.cachePolicy || { ...DEFAULT_POLICY, ...config.cache },
          downloadHistory: parsed.downloadHistory || [],
        };
      } catch {
        // fall through to default
      }
    }
    return {
      nextPackageId: 1,
      nextVersionId: 1,
      packages: [],
      versions: [],
      storageTrend: [],
      cachePolicy: { ...DEFAULT_POLICY, ...config.cache },
      downloadHistory: [],
    };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 200);
  }

  private persist(): void {
    ensureDir(this.dataDir);
    const tmpPath = this.dbPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.db, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.dbPath);
  }

  getOrCreatePackage(
    name: string,
    registry: RegistryType,
    source: PackageSource,
    scope?: string
  ): number {
    const existing = this.db.packages.find(
      (p) => p.name === name && p.registry === registry
    );
    if (existing) return existing.id;

    const now = Date.now();
    const id = this.db.nextPackageId++;
    this.db.packages.push({
      id,
      name,
      registry,
      source,
      scope,
      latestVersion: '',
      createdAt: now,
      updatedAt: now,
      totalSize: 0,
      downloadCount: 0,
      lastAccessedAt: now,
    });
    this.scheduleSave();
    return id;
  }

  upsertPackageInfo(info: Partial<PackageInfo> & { name: string; registry: RegistryType }): void {
    const existing = this.db.packages.find(
      (p) => p.name === info.name && p.registry === info.registry
    );
    const now = Date.now();

    if (existing) {
      if (info.description !== undefined) existing.description = info.description;
      if (info.author !== undefined) existing.author = info.author;
      if (info.license !== undefined) existing.license = info.license;
      if (info.latestVersion !== undefined) existing.latestVersion = info.latestVersion;
      if (info.source !== undefined) existing.source = info.source;
      existing.updatedAt = now;
    } else {
      this.getOrCreatePackage(info.name, info.registry, info.source || 'cache', info.scope);
    }
    this.scheduleSave();
  }

  addVersion(
    packageId: number,
    version: string,
    size: number,
    filePath: string,
    sha1?: string
  ): void {
    const now = Date.now();
    const existing = this.db.versions.find(
      (v) => v.packageId === packageId && v.version === version
    );
    if (existing) {
      existing.size = size;
      existing.filePath = filePath;
      if (sha1) existing.sha1 = sha1;
      existing.publishedAt = now;
    } else {
      const id = this.db.nextVersionId++;
      this.db.versions.push({
        id,
        packageId,
        version,
        size,
        filePath,
        sha1,
        publishedAt: now,
        downloadCount: 0,
      });
    }
    this.recalcPackageSize(packageId);
    const pkg = this.db.packages.find((p) => p.id === packageId);
    if (pkg) pkg.updatedAt = now;
    this.scheduleSave();
  }

  private recalcPackageSize(packageId: number): void {
    const pkgVersions = this.db.versions.filter((v) => v.packageId === packageId);
    const total = pkgVersions.reduce((s, v) => s + v.size, 0);
    const latest = pkgVersions.sort((a, b) => b.publishedAt - a.publishedAt)[0];

    const pkg = this.db.packages.find((p) => p.id === packageId);
    if (pkg) {
      pkg.totalSize = total;
      pkg.latestVersion = latest?.version || '';
    }
  }

  incrementVersionDownload(packageId: number, version: string): void {
    const v = this.db.versions.find(
      (v) => v.packageId === packageId && v.version === version
    );
    if (v) v.downloadCount++;
    const pkg = this.db.packages.find((p) => p.id === packageId);
    const now = Date.now();
    const today = formatLocalDate(now);
    if (pkg) {
      pkg.downloadCount++;
      pkg.lastAccessedAt = now;
    }
    const existingHistory = this.db.downloadHistory.find(
      (h) => h.packageId === packageId && h.date === today
    );
    if (existingHistory) {
      existingHistory.count++;
    } else {
      this.db.downloadHistory.push({
        packageId,
        date: today,
        count: 1,
      });
    }
    this.cleanupOldDownloadHistory();
    this.scheduleSave();
  }

  private cleanupOldDownloadHistory(): void {
    const cutoffDate = getLocalDateBeforeDays(365);
    this.db.downloadHistory = this.db.downloadHistory.filter(
      (h) => h.date >= cutoffDate
    );
  }

  private getDownloadsInRange(packageId: number, startDate: string, endDate?: string): number {
    return this.db.downloadHistory
      .filter((h) => {
        if (endDate) {
          return h.packageId === packageId && h.date >= startDate && h.date <= endDate;
        }
        return h.packageId === packageId && h.date >= startDate;
      })
      .reduce((sum, h) => sum + h.count, 0);
  }

  private isSmallBaseEdgeCase(
    periodDownloads: number,
    previousPeriodDownloads: number
  ): boolean {
    const SMALL_BASE_THRESHOLD = 5;
    const bothSmall = previousPeriodDownloads < SMALL_BASE_THRESHOLD && periodDownloads < SMALL_BASE_THRESHOLD;
    const droppedToZero = previousPeriodDownloads < SMALL_BASE_THRESHOLD && periodDownloads === 0;
    return bothSmall || droppedToZero;
  }

  private calculateTrendInfo(
    periodDownloads: number,
    previousPeriodDownloads: number,
    totalDownloads: number
  ): { trend: PackageRankingItem['trend']; trendPercent: number } {
    const hasPeriod = periodDownloads > 0;
    const hasPrevious = previousPeriodDownloads > 0;
    const hasAny = totalDownloads > 0;

    if (!hasAny) {
      return { trend: 'inactive', trendPercent: 0 };
    }

    if (!hasPrevious && hasPeriod) {
      return { trend: 'new', trendPercent: 0 };
    }

    if (!hasPeriod && !hasPrevious && hasAny) {
      return { trend: 'inactive', trendPercent: 0 };
    }

    if (this.isSmallBaseEdgeCase(periodDownloads, previousPeriodDownloads)) {
      return { trend: 'inactive', trendPercent: 0 };
    }

    if (hasPrevious) {
      const trendPercent = ((periodDownloads - previousPeriodDownloads) / previousPeriodDownloads) * 100;
      let trend: PackageRankingItem['trend'] = 'flat';
      if (trendPercent > 5) trend = 'up';
      else if (trendPercent < -5) trend = 'down';
      else trend = 'flat';
      return { trend, trendPercent };
    }

    return { trend: 'flat', trendPercent: 0 };
  }

  private buildRankingItem(
    pkg: DBPackage,
    period: TrendPeriod
  ): PackageRankingItem {
    const { start, prevStart, prevEnd, days } = getLocalDateRangeForPeriod(period);
    const periodDownloads = this.getDownloadsInRange(pkg.id, start);
    const previousPeriodDownloads = this.getDownloadsInRange(pkg.id, prevStart, prevEnd);
    const { trend, trendPercent } = this.calculateTrendInfo(
      periodDownloads,
      previousPeriodDownloads,
      pkg.downloadCount
    );

    return {
      name: pkg.name,
      registry: pkg.registry,
      source: pkg.source,
      downloadCount: pkg.downloadCount,
      periodDownloads,
      previousPeriodDownloads,
      trend,
      trendPercent,
      lastAccessedAt: pkg.lastAccessedAt,
      dailyDownloads: getDailyDownloadsLocal(pkg.id, days, this.db.downloadHistory),
    };
  }

  getTopPackages(period: TrendPeriod = 'week', limit: number = 10): PackageRankingItem[] {
    const rankings = this.db.packages
      .map((pkg) => this.buildRankingItem(pkg, period))
      .sort((a, b) => b.periodDownloads - a.periodDownloads || b.downloadCount - a.downloadCount)
      .slice(0, limit);

    return rankings;
  }

  getPackage(name: string, registry: RegistryType): PackageInfo | null {
    const pkg = this.db.packages.find(
      (p) => p.name === name && p.registry === registry
    );
    if (!pkg) return null;

    const versions = this.db.versions
      .filter((v) => v.packageId === pkg.id)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .map<PackageVersion>((v) => ({
        version: v.version,
        size: v.size,
        filePath: v.filePath,
        sha1: v.sha1,
        publishedAt: v.publishedAt,
        downloadCount: v.downloadCount,
      }));

    return {
      name: pkg.name,
      registry: pkg.registry,
      source: pkg.source,
      scope: pkg.scope,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      latestVersion: pkg.latestVersion,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      totalSize: pkg.totalSize,
      downloadCount: pkg.downloadCount,
      versions,
    };
  }

  listPackages(options: {
    registry?: RegistryType;
    source?: PackageSource;
    search?: string;
    limit?: number;
    offset?: number;
    sortBy?: 'name' | 'updatedAt' | 'size' | 'downloads';
    sortOrder?: 'asc' | 'desc';
  } = {}): { packages: PackageInfo[]; total: number } {
    let list = [...this.db.packages];

    if (options.registry) list = list.filter((p) => p.registry === options.registry);
    if (options.source) list = list.filter((p) => p.source === options.source);
    if (options.search) {
      const s = options.search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(s));
    }

    const total = list.length;

    const sortField = options.sortBy === 'size' ? 'totalSize' :
      options.sortBy === 'downloads' ? 'downloadCount' :
      options.sortBy === 'updatedAt' ? 'updatedAt' : 'name';
    const order = options.sortOrder?.toUpperCase() === 'ASC' ? 1 : -1;

    list.sort((a: any, b: any) => {
      const va = a[sortField];
      const vb = b[sortField];
      if (typeof va === 'string') return va.localeCompare(vb) * order;
      return (va - vb) * order;
    });

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    list = list.slice(offset, offset + limit);

    const idSet = new Set(list.map((p) => p.id));
    const versionsByPkg: Record<number, DBVersion[]> = {};
    for (const v of this.db.versions) {
      if (idSet.has(v.packageId)) {
        if (!versionsByPkg[v.packageId]) versionsByPkg[v.packageId] = [];
        versionsByPkg[v.packageId].push(v);
      }
    }
    for (const arr of Object.values(versionsByPkg)) {
      arr.sort((a, b) => b.publishedAt - a.publishedAt);
    }

    const packages: PackageInfo[] = list.map((pkg) => ({
      name: pkg.name,
      registry: pkg.registry,
      source: pkg.source,
      scope: pkg.scope,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      latestVersion: pkg.latestVersion,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      totalSize: pkg.totalSize,
      downloadCount: pkg.downloadCount,
      versions: (versionsByPkg[pkg.id] || []).map<PackageVersion>((v) => ({
        version: v.version,
        size: v.size,
        filePath: v.filePath,
        sha1: v.sha1,
        publishedAt: v.publishedAt,
        downloadCount: v.downloadCount,
      })),
    }));

    return { packages, total };
  }

  getVersionFilePath(packageName: string, registry: RegistryType, version: string): string | null {
    const pkg = this.db.packages.find(
      (p) => p.name === packageName && p.registry === registry
    );
    if (!pkg) return null;
    const ver = this.db.versions.find(
      (v) => v.packageId === pkg.id && v.version === version
    );
    return ver?.filePath || null;
  }

  deletePackage(name: string, registry: RegistryType): boolean {
    const idx = this.db.packages.findIndex(
      (p) => p.name === name && p.registry === registry
    );
    if (idx < 0) return false;
    const [pkg] = this.db.packages.splice(idx, 1);
    this.db.versions = this.db.versions.filter((v) => v.packageId !== pkg.id);
    this.scheduleSave();
    return true;
  }

  deletePackageVersion(name: string, registry: RegistryType, version: string): boolean {
    const pkg = this.db.packages.find(
      (p) => p.name === name && p.registry === registry
    );
    if (!pkg) return false;

    const idx = this.db.versions.findIndex(
      (v) => v.packageId === pkg.id && v.version === version
    );
    if (idx < 0) return false;

    this.db.versions.splice(idx, 1);
    this.recalcPackageSize(pkg.id);
    this.scheduleSave();
    return true;
  }

  getStats(): CacheStats {
    const totalPackages = this.db.packages.length;
    const totalVersions = this.db.versions.length;
    const totalSize = this.db.packages.reduce((s, p) => s + p.totalSize, 0);
    const npmPackages = this.db.packages.filter((p) => p.registry === 'npm').length;
    const pypiPackages = this.db.packages.filter((p) => p.registry === 'pypi').length;
    const privatePackages = this.db.packages.filter((p) => p.source === 'private').length;
    const cachePackages = this.db.packages.filter((p) => p.source === 'cache').length;

    const policy = this.getCachePolicy();
    const maxSizeBytes = policy.maxSizeGB * 1024 * 1024 * 1024;
    const dirSize = getDirSize(config.storageDir);
    const actualSize = Math.max(totalSize, dirSize);

    return {
      totalPackages,
      totalVersions,
      totalSize: actualSize,
      npmPackages,
      pypiPackages,
      privatePackages,
      cachePackages,
      maxSize: maxSizeBytes,
      usagePercent: actualSize > 0 && maxSizeBytes > 0 ? Math.min(100, (actualSize / maxSizeBytes) * 100) : 0,
    };
  }

  getStorageTrend(days: number = 30): StorageTrend[] {
    return this.db.storageTrend.slice(-days);
  }

  recordStorageSnapshot(): void {
    const stats = this.getStats();
    const date = formatDate(Date.now());
    const idx = this.db.storageTrend.findIndex((t) => t.date === date);
    const entry: StorageTrend = {
      date,
      size: stats.totalSize,
      packages: stats.totalPackages,
    };
    if (idx >= 0) {
      this.db.storageTrend[idx] = entry;
    } else {
      this.db.storageTrend.push(entry);
    }
    if (this.db.storageTrend.length > 365) {
      this.db.storageTrend = this.db.storageTrend.slice(-365);
    }
    this.scheduleSave();
  }

  getCachePolicy(): CachePolicy {
    return { ...this.db.cachePolicy };
  }

  updateCachePolicy(policy: CachePolicy): void {
    this.db.cachePolicy = { ...policy };
    this.scheduleSave();
  }

  getOldPackages(maxAgeDays: number): Array<{ name: string; registry: RegistryType; filePath: string }> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const pkgMap = new Map(this.db.packages.map((p) => [p.id, p]));
    const result: Array<{ name: string; registry: RegistryType; filePath: string }> = [];
    for (const v of this.db.versions) {
      const pkg = pkgMap.get(v.packageId);
      if (pkg && pkg.updatedAt < cutoff && pkg.source === 'cache') {
        result.push({ name: pkg.name, registry: pkg.registry, filePath: v.filePath });
      }
    }
    return result;
  }

  getPackagesForEviction(neededBytes: number): Array<{ name: string; registry: RegistryType; version: string; filePath: string; size: number }> {
    const pkgMap = new Map(this.db.packages.map((p) => [p.id, p]));
    const rows = this.db.versions
      .map((v) => {
        const pkg = pkgMap.get(v.packageId)!;
        return {
          name: pkg.name,
          registry: pkg.registry,
          version: v.version,
          filePath: v.filePath,
          size: v.size,
          _downloads: pkg.downloadCount,
          _updated: pkg.updatedAt,
          _isCache: pkg.source === 'cache',
        };
      })
      .filter((r) => r._isCache)
      .sort((a, b) => a._downloads - b._downloads || a._updated - b._updated);

    const result: Array<{ name: string; registry: RegistryType; version: string; filePath: string; size: number }> = [];
    let acc = 0;
    for (const r of rows) {
      result.push({
        name: r.name,
        registry: r.registry,
        version: r.version,
        filePath: r.filePath,
        size: r.size,
      });
      acc += r.size;
      if (acc >= neededBytes) break;
    }
    return result;
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.persist();
  }
}

let metadataInstance: MetadataIndex | null = null;

export function getMetadataIndex(): MetadataIndex {
  if (!metadataInstance) {
    metadataInstance = new MetadataIndex(config.dataDir);
  }
  return metadataInstance;
}
