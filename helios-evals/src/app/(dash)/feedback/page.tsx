import { requireDev } from "@/lib/gatewayServer";
import { FeedbackBoard } from "@/components/FeedbackBoard";

export default async function FeedbackPage() {
  await requireDev();
  return (
    <>
      <h1 className="font-serif text-[28px]">Feedback</h1>
      <p className="mt-1 max-w-[760px] text-[14px] text-muted">
        What users said about their chats (asked once a chat has a list). Work through it with
        the status; a chat worth testing again can go straight into the replay dataset.
      </p>
      <FeedbackBoard />
    </>
  );
}
