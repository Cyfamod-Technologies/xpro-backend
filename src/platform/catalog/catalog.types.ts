import type { DateRole, QuestionType } from '@prisma/client';

export type QuestionConfig = {
  min?: number;
  max?: number;
  integer?: boolean;
  exclusiveMinimum?: boolean;
  minLength?: number;
  maxLength?: number;
};

export type CatalogOption = { id: string; label: string; active: boolean };

export type CatalogQuestion = {
  id: string;
  serviceId: string;
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  required: boolean;
  sortOrder: number;
  active: boolean;
  options: CatalogOption[];
  config: QuestionConfig;
  dateRole: DateRole | null;
  sensitive: boolean;
  matchesSkill: boolean;
  version: number;
};

export type CatalogNode = {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  depth: number;
  sortOrder: number;
  active: boolean;
  requiresStartDate: boolean;
  version: number;
  questions: CatalogQuestion[];
  children: CatalogNode[];
};

export type CatalogIndex = {
  roots: CatalogNode[];
  byId: Map<string, CatalogNode>;
};

export type ResolvedService = {
  path: CatalogNode[];
  questions: CatalogQuestion[];
};
