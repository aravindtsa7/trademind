import { ResearchRunResult } from './research-run.dto';

export type ResearchReportSectionType =
  | 'METADATA'
  | 'SIGNAL_SUMMARY'
  | 'PERFORMANCE'
  | 'REGIME_ANALYSIS'
  | 'COMPARISON_SUMMARY';

export interface ResearchReportSectionDto {
  type: ResearchReportSectionType;
  title: string;
  lines: string[];
}

export interface ResearchReportDto {
  sections: ResearchReportSectionDto[];
  text: string;
}

export type ResearchReportInput = ResearchRunResult | readonly ResearchRunResult[];
