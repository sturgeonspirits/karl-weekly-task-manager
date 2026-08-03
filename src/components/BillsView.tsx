import { BadgeDollarSign, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { Bill } from "../types";
import { currency, makeId, todayStr } from "../utils";

type BillsViewProps = {
  bills: Bill[];
  onSaveBills: (bills: Bill[]) => void;
};

type BillForm = {
  name: string;
  amount: string;
  dueDate: string;
  category: string;
  recurring: boolean;
};

export function BillsView({ bills, onSaveBills }: BillsViewProps) {
  const [form, setForm] = useState<BillForm>({
    name: "",
    amount: "",
    dueDate: todayStr(),
    category: "",
    recurring: false,
  });

  const summary = useMemo(() => {
    const outstanding = bills.filter((bill) => !bill.paid).reduce((sum, bill) => sum + bill.amount, 0);
    const paid = bills.filter((bill) => bill.paid).reduce((sum, bill) => sum + bill.amount, 0);
    const nextDue = bills
      .filter((bill) => !bill.paid)
      .slice()
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate;

    return { outstanding, paid, nextDue: nextDue || "Clear" };
  }, [bills]);

  function update<K extends keyof BillForm>(key: K, value: BillForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    const amount = Number(form.amount);
    if (!name || !amount || !form.dueDate) return;
    onSaveBills([
      ...bills,
      {
        id: makeId("bill"),
        name,
        amount,
        dueDate: form.dueDate,
        paid: false,
        category: form.category.trim() || undefined,
        recurring: form.recurring,
        updatedAt: Date.now(),
      },
    ]);
    setForm({ name: "", amount: "", dueDate: todayStr(), category: "", recurring: false });
  }

  function toggleBill(id: string) {
    onSaveBills(bills.map((bill) => (bill.id === id ? { ...bill, paid: !bill.paid, updatedAt: Date.now() } : bill)));
  }

  function deleteBill(id: string) {
    onSaveBills(bills.filter((bill) => bill.id !== id));
  }

  return (
    <section className="content-surface">
      <div>
        <p className="eyebrow">Bills & expenses</p>
        <h2 className="page-title">Financial ledger</h2>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="summary-tile">
          <span>Total Outstanding</span>
          <strong>{currency(summary.outstanding)}</strong>
        </div>
        <div className="summary-tile">
          <span>Total Paid</span>
          <strong>{currency(summary.paid)}</strong>
        </div>
        <div className="summary-tile">
          <span>Next Due Date</span>
          <strong>{summary.nextDue}</strong>
        </div>
      </div>

      <form className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_9rem_11rem_minmax(0,1fr)_auto_auto]" onSubmit={submit}>
        <label className="sr-only" htmlFor="bill-name">
          Bill name
        </label>
        <input
          id="bill-name"
          value={form.name}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Bill name"
        />
        <label className="sr-only" htmlFor="bill-amount">
          Amount
        </label>
        <input
          id="bill-amount"
          type="number"
          min="0"
          step="0.01"
          value={form.amount}
          onChange={(event) => update("amount", event.target.value)}
          placeholder="Amount"
        />
        <label className="sr-only" htmlFor="bill-date">
          Due date
        </label>
        <input id="bill-date" type="date" value={form.dueDate} onChange={(event) => update("dueDate", event.target.value)} />
        <label className="sr-only" htmlFor="bill-category">
          Category
        </label>
        <input
          id="bill-category"
          value={form.category}
          onChange={(event) => update("category", event.target.value)}
          placeholder="Category"
        />
        <label className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={form.recurring}
            onChange={(event) => update("recurring", event.target.checked)}
          />
          Recurring
        </label>
        <button className="btn-primary" type="submit">
          <Plus size={17} />
          Add
        </button>
      </form>

      <div className="mt-5 grid gap-3">
        {bills
          .slice()
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((bill) => (
            <article key={bill.id} className={`bill-row ${bill.paid ? "bill-row-paid" : ""}`}>
              <button
                className="icon-button"
                type="button"
                aria-label={`Toggle ${bill.name} paid`}
                onClick={() => toggleBill(bill.id)}
              >
                {bill.paid ? <CheckCircle2 size={18} /> : <BadgeDollarSign size={18} />}
              </button>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-950">{bill.name}</h3>
                <p className="text-xs text-slate-500">
                  {bill.dueDate}
                  {bill.category ? ` · ${bill.category}` : ""}
                  {bill.recurring ? " · recurring" : ""}
                </p>
              </div>
              <strong className="text-right text-sm text-slate-950">{currency(bill.amount)}</strong>
              <button className="icon-button" type="button" aria-label={`Delete ${bill.name}`} onClick={() => deleteBill(bill.id)}>
                <Trash2 size={15} />
              </button>
            </article>
          ))}
      </div>
    </section>
  );
}
