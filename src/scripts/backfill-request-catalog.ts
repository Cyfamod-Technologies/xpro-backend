import { PrismaClient } from '@prisma/client';
import { loadCatalog } from '../platform/catalog/catalog.tree';
import type {
  CatalogOption,
  CatalogQuestion,
  ResolvedService,
} from '../platform/catalog/catalog.types';
import type { AnswerSnapshot } from '../requests/domain/answers';
import { resolveServiceInput } from '../requests/domain/legacy-service-input';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

function option(question: CatalogQuestion, value: unknown) {
  return typeof value === 'string'
    ? question.options.find(
        (item: CatalogOption) => item.id === value || item.label === value,
      )
    : undefined;
}

function snapshotFor(
  question: CatalogQuestion,
  resolved: ResolvedService,
  raw: unknown,
): AnswerSnapshot | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let value: AnswerSnapshot['value'];
  let display: string;
  let optionIds: string[] | undefined;
  if (question.type === 'yes_no') {
    if (raw !== 'Yes' && raw !== 'No') return null;
    value = display = raw;
  } else if (question.type === 'single_choice') {
    const picked = option(question, raw);
    if (!picked) return null;
    value = display = picked.label;
    optionIds = [picked.id];
  } else if (question.type === 'multiple_choice') {
    const picked = Array.isArray(raw)
      ? raw.map((item: unknown) => option(question, item))
      : [];
    if (!picked.length || picked.some((item) => !item)) return null;
    const found = picked as CatalogOption[];
    value = found.map(({ label }) => label);
    display = value.join(', ');
    optionIds = found.map(({ id }) => id);
  } else if (question.type === 'number') {
    const number = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(number)) return null;
    value = number;
    display = String(number);
  } else {
    if (typeof raw !== 'string') return null;
    value = display = raw.trim();
  }
  return {
    questionId: question.id,
    serviceId: question.serviceId,
    serviceName:
      resolved.path.find(({ id }) => id === question.serviceId)?.name ?? '',
    key: question.key,
    label: question.label,
    type: question.type,
    value,
    display,
    ...(optionIds ? { optionIds } : {}),
    sensitive: question.sensitive,
    ...(question.dateRole ? { dateRole: question.dateRole } : {}),
    matchesSkill: question.matchesSkill,
  };
}

async function main() {
  const catalog = await loadCatalog(prisma);
  const rows = await prisma.serviceRequest.findMany({
    where: { serviceId: null },
    select: { id: true, number: true, service: true, details: true },
    orderBy: { number: 'asc' },
  });
  let mapped = 0;
  let rootOnly = 0;
  let unmapped = 0;
  for (const row of rows) {
    const details =
      row.details && typeof row.details === 'object'
        ? (row.details as Record<string, unknown>)
        : {};
    const resolved = resolveServiceInput(
      catalog,
      { service: row.service, details },
      { includeInactive: true },
    );
    if (!resolved) {
      console.warn(
        `Unmapped request: XPR-${row.number} — service "${row.service}"`,
      );
      unmapped += 1;
      continue;
    }
    const root = resolved.path[0];
    const leaf = resolved.path[resolved.path.length - 1];
    if (leaf.id === root.id && root.children.length > 0) {
      console.warn(
        `Request XPR-${row.number} has no recognisable sub-service; only the root "${root.name}" is set`,
      );
      rootOnly += 1;
      if (!dryRun)
        await prisma.$executeRaw`UPDATE service_requests SET service_root_id = ${root.id} WHERE id = ${row.id}`;
      continue;
    }
    const answers = resolved.questions.flatMap((question) => {
      const snapshot = snapshotFor(question, resolved, details[question.key]);
      return snapshot ? [snapshot] : [];
    });
    mapped += 1;
    if (dryRun) continue;
    const path = JSON.stringify(
      resolved.path.map(({ id, name }) => ({ id, name })),
    );
    await prisma.$executeRaw`UPDATE service_requests
      SET service_id = ${leaf.id}, service_root_id = ${root.id},
          service_path = ${path}::jsonb, answers = ${JSON.stringify(answers)}::jsonb
      WHERE id = ${row.id}`;
  }
  console.log(
    `${dryRun ? 'Would map' : 'Mapped'} ${mapped} requests; ${rootOnly} root-only, ${unmapped} unmapped, ${rows.length} without a catalog service.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
