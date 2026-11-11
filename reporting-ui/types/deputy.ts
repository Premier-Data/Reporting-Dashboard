export interface DeputyShift {
  employee_name: string;

  area_name?: string;
  area?: string;

  week?: string | number;
  week_name?: string;
  week_start?: string;
  pay_week?: string;

  start_date?: string;

  total_hours: number;
  total_cost: number;

  shift_hours?: number;
  hourly_rate?: number | null;
}