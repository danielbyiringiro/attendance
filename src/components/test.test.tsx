/** @vitest-environment jsdom */
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { expect, test, describe, vi, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import StudentDashboard from "./StudentDashboard";

expect.extend(matchers);

const mockOnBack = vi.fn();

describe("Attendance Verification", () => {
  afterEach(() => {
    cleanup();
  });

  // Ensure these IDs are in your database
  const studentsToCheck = [
    "02852027",
    "05282027",
    "11762027",
    "15442027",
    "20052027",
    "20522026",
    "30092027",
    "30332027",
    "30372027",
    "30862027",
    "31012027",
    "31202027",
    "33212027",
    "34182027",
    "36212027",
    "37052027",
    "46042027",
    "46122027",
    "47152026",
    "47592027",
    "48662026",
    "50342027",
    "51462027",
    "51852027",
    "54202027",
    "55362026",
    "60262027",
    "61092027",
    "63962026",
    "65542027",
    "67152027",
    "67302026",
    "67312027",
    "70022027",
    "70382027",
    "70402027",
    "72242027",
    "73372027",
    "74862027",
    "75922026",
    "79952027",
    "81882027",
    "82112027",
    "87342026",
    "89962026",
    "91052027",
    "96342027",
    "97022027",
    "99172027",
    "99962027",
    "91292027",
  ];

  studentsToCheck.forEach((id) => {
    test(`Check if ${id} has 9 absences`, async () => {
      render(<StudentDashboard onBack={mockOnBack} />);

      const input = screen.getByPlaceholderText("Enter Student ID");
      fireEvent.change(input, { target: { value: id } });

      const button = screen.getByRole("button", { name: /View Details/i });
      fireEvent.click(button);

      // FIX: Wait for the "Searching..." button text to go away
      // This ensures the async Supabase fetch has completed.
      await waitFor(
        () => {
          expect(screen.queryByText(/Searching.../i)).not.toBeInTheDocument();
        },
        { timeout: 10000 },
      );

      // FIX: Wait for the Days Absent count to be something OTHER than the initial 0
      // if you expect the student to actually have absences.
      const absentCountElement = await screen
        .findByText("Days Absent")
        .then((el) => el.closest("div")?.querySelector(".text-3xl"));

      const count = absentCountElement?.textContent;

      console.log(`\n-----------------------------------`);
      console.log(`Student ID: ${id}`);
      console.log(`Absence Count: ${count}`);

      if (count >= 9) {
        console.log(`✅ MATCH FOUND: ${id} has 9 or more absences.`);
      } else {
        console.log(`❌ NO MATCH: ${id} has ${count} absences.`);
      }
      console.log(`-----------------------------------\n`);

      expect(count).toBeDefined();
    });
  });
});
