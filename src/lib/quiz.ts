import adsp from '../data/quiz/adsp.json';
import aws17 from '../data/quiz/aws-1-7.json';
import aws812 from '../data/quiz/aws-8-12.json';
import information from '../data/quiz/information.json';

export interface ChoiceQuestion {
  no: number;
  question: string;
  choices: string[];
  answers: string[];
  answerNote: string | null;
  explanation: string;
}

export interface SubjectiveQuestion {
  no: number;
  question: string;
  answer: string;
  acceptedAnswers?: string[];
  explanation: string;
  image: string | null;
}

export type Question = ChoiceQuestion | SubjectiveQuestion;

export interface Chapter {
  slug: string;
  title: string;
  count: number;
  questions: Question[];
}

export interface Course {
  id: string;
  label: string;
  desc: string;
  category: string;
  type: 'multiple-choice' | 'subjective';
  total: number;
  chapters: Chapter[];
}

export const courseData = {
  'aws-1-7': aws17,
  'aws-8-12': aws812,
  adsp,
  information,
} as unknown as Record<string, Course>;

export const allCourses = Object.values(courseData);

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
