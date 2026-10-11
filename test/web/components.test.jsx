// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuestionModal } from '../../web/src/components/QuestionModal.jsx';
import { ErrorBox, Button } from '../../web/src/components/ui.jsx';

afterEach(cleanup);

describe('componenti', () => {
  it('QuestionModal mostra la domanda e risponde', () => {
    const onAnswer = vi.fn();
    render(<QuestionModal question={{ id: 'q1', text: 'Avvio a 1,79 $/h. Confermi?', defYes: false }} onAnswer={onAnswer} />);
    expect(screen.getByText('Avvio a 1,79 $/h. Confermi?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' }).className).toMatch(/ring/);
    fireEvent.click(screen.getByRole('button', { name: 'Sì' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it('ErrorBox mostra messaggio e suggerimento', () => {
    render(<ErrorBox error={{ message: 'Nessuna GPU', hint: 'Riprova più tardi' }} />);
    expect(screen.getByText('Nessuna GPU')).toBeTruthy();
    expect(screen.getByText('Riprova più tardi')).toBeTruthy();
  });

  it('Button in caricamento è disabilitato', () => {
    render(<Button loading>Avvia</Button>);
    expect(screen.getByRole('button').disabled).toBe(true);
  });
});
