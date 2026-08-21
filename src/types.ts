export type Priority = "low" | "medium" | "high";
export type RepeatPattern = "weekly" | "biweekly" | "monthly" | "none";

export interface Task {
  id: string;
  title: string;
  description?: string;
  dayOfWeek: number;
  completed: boolean;
  priority: Priority;
  category: string;
  weekId: string;
  repeatsWeekly?: boolean;
  repeatPattern?: RepeatPattern;
  originTaskId?: string;
  deleted?: boolean;
  specificDate?: string;
  reminderDate?: string;
  specificDateWasExplicit?: boolean;
  updatedAt?: number;
  assignee?: string;
  shiftHours?: string;
  source?: "private" | "staff";
  isGeneralReminder?: boolean;
  needsSheetRepair?: boolean;
}

export interface CategoryOption {
  id: string;
  name: string;
  color: string;
}

export interface Bill {
  id: string;
  name: string;
  payee?: string;
  amount: number;
  dueDate: string;
  paid: boolean;
  /**
   * v1.1 -- 2026-08-21 -- Partial payments.
   * Dollars paid against this bill so far. Always between 0 and `amount`; equals `amount`
   * whenever `paid` is true. Absent on bills that predate partial payments (treat as 0).
   */
  amountPaid?: number;
  category?: string;
  recurring?: boolean;
  frequency?: string;
  status?: string;
  autoPay?: boolean;
  paymentAccount?: string;
  notes?: string;
  updatedAt?: number;
  deleted?: boolean;
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  email?: string;
  phone?: string;
  color?: string;
}

export type DailyEvents = Record<string, string>;

export interface OperationsSnapshot {
  tasks: Task[];
  categories: CategoryOption[];
  bills: Bill[];
  staff: StaffMember[];
  dailyEvents: DailyEvents;
  staffDailyEvents?: DailyEvents;
}
