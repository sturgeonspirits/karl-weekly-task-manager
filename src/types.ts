export type Priority = "low" | "medium" | "high";

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
  repeatPattern?: "weekly" | "biweekly" | "none";
  originTaskId?: string;
  deleted?: boolean;
  specificDate?: string;
  specificDateWasExplicit?: boolean;
  updatedAt?: number;
  assignee?: string;
  shiftHours?: string;
  source?: "private" | "staff";
  isGeneralReminder?: boolean;
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
  category?: string;
  recurring?: boolean;
  frequency?: string;
  status?: string;
  autoPay?: boolean;
  paymentAccount?: string;
  notes?: string;
  updatedAt?: number;
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
}
