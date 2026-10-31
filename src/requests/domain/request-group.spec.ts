import { AppError } from '../../platform/errors/app-error';
import {
  checkGroupServices,
  checkNoProjectFiles,
  childTitle,
  formatGroupRef,
  intakeFieldPath,
  parseGroupRef,
  servicesLimit,
  withFieldPath,
} from './request-group';

const thrown = (run: () => void): AppError => {
  try {
    run();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Expected the call to throw.');
};

describe('request group checks', () => {
  const service = (serviceId: string) => ({ serviceId });

  it('refuses an empty or missing list with the limit message', () => {
    for (const services of [[], undefined, null, 'x']) {
      const error = thrown(() => checkGroupServices(services, 5));
      expect(error.getStatus()).toBe(422);
      expect(error.message).toBe('You can request up to 5 services at a time.');
    }
  });

  it('refuses more services than the limit it is given', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(service);
    expect(thrown(() => checkGroupServices(six, 5)).message).toBe(
      'You can request up to 5 services at a time.',
    );
    expect(thrown(() => checkGroupServices(six.slice(0, 3), 2)).message).toBe(
      'You can request up to 2 services at a time.',
    );
    expect(() => checkGroupServices(six.slice(0, 5), 5)).not.toThrow();
  });

  it('refuses the same service twice and points at the second card', () => {
    const error = thrown(() =>
      checkGroupServices([service('a'), service('b'), service('a')], 5),
    );
    expect(error.message).toBe(
      'Add each service once. Use the quantity field to ask for more than one.',
    );
    expect(error.details).toEqual({ field: 'services[2].serviceId' });
  });

  it('checks the count before repeated services', () => {
    expect(
      thrown(() =>
        checkGroupServices([service('a'), service('a'), service('a')], 2),
      ).message,
    ).toBe('You can request up to 2 services at a time.');
  });
});

describe('servicesLimit', () => {
  it('reads the setting and falls back to the default of 5', () => {
    expect(servicesLimit({ 'request.maxServicesPerSubmission': 3 })).toBe(3);
    expect(servicesLimit({})).toBe(5);
    expect(servicesLimit({ 'request.maxServicesPerSubmission': 'x' })).toBe(5);
  });
});

describe('childTitle', () => {
  it('joins the project title and the leaf name', () => {
    expect(childTitle('Office fit-out', 'Roof and ceiling')).toBe(
      'Office fit-out — Roof and ceiling',
    );
  });

  it('cuts the project part so the title stays within 120 characters', () => {
    const title = childTitle('P'.repeat(120), 'Waste collection');
    expect(title).toHaveLength(120);
    expect(title.endsWith(' — Waste collection')).toBe(true);
    expect(title.startsWith('PPP')).toBe(true);
  });

  it('keeps a title that already fits and drops trailing spaces at the cut', () => {
    const fits = 'P'.repeat(100);
    expect(childTitle(fits, 'Plumber')).toBe(`${fits} — Plumber`);
    const cut = childTitle(`${'P'.repeat(109)} ${'Q'.repeat(30)}`, 'Plumber');
    expect(cut).toBe(`${'P'.repeat(109)} — Plumber`);
  });
});

describe('formatGroupRef', () => {
  it('pads the sequence like XPR ids', () => {
    expect(formatGroupRef(1)).toBe('XPG-00001');
    expect(formatGroupRef(BigInt(42))).toBe('XPG-00042');
    expect(formatGroupRef(123456)).toBe('XPG-123456');
  });
});

describe('intakeFieldPath', () => {
  const questions = [
    { id: 'q-qty', label: 'Estimated quantity and unit', dateRole: null },
    { id: 'q-end', label: 'Hire end date', dateRole: 'end' },
  ];
  const context = {
    index: 1,
    title: 'Project',
    address: '12 Example Road',
    providerField: 'providerId',
    questions,
  };

  it('prefixes the service fields with the card index and leaves shared fields plain', () => {
    expect(
      intakeFieldPath(
        'Add a title and a project brief of at least 20 characters.',
        context,
      ),
    ).toBe('services[1].description');
    expect(
      intakeFieldPath(
        'Add a title and a project brief of at least 20 characters.',
        {
          ...context,
          title: 'ab',
        },
      ),
    ).toBe('title');
    expect(
      intakeFieldPath('Enter a valid Nigerian phone number.', context),
    ).toBe('phone');
    expect(
      intakeFieldPath('Complete your contact and site details.', {
        ...context,
        address: 'abc',
      }),
    ).toBe('address');
    expect(
      intakeFieldPath('Budget must be zero or a positive amount.', context),
    ).toBe('services[1].budget');
    expect(intakeFieldPath('Choose a valid service.', context)).toBe(
      'services[1].serviceId',
    );
  });

  it('points an answer message at services[i].answers.<questionId>', () => {
    expect(
      intakeFieldPath('Complete estimated quantity and unit.', context),
    ).toBe('services[1].answers.q-qty');
    expect(
      intakeFieldPath('Choose a valid estimated quantity and unit.', context),
    ).toBe('services[1].answers.q-qty');
    expect(
      intakeFieldPath('Estimated quantity and unit must be a number.', context),
    ).toBe('services[1].answers.q-qty');
    expect(
      intakeFieldPath(
        'Hire end date cannot be before the start date.',
        context,
      ),
    ).toBe('services[1].answers.q-end');
  });

  it('puts every attachment message on the service that owns the files, and gives up on unknown messages', () => {
    for (const message of [
      "One of your files didn't finish uploading. Remove it and try again.",
      'A request can hold up to 20 files. Remove one before adding more.',
      'Keep the combined file size under 25 MB.',
    ])
      expect(intakeFieldPath(message, context)).toBe('services[1].attachments');
    expect(intakeFieldPath('Something else.', context)).toBeNull();
  });
});

describe('checkNoProjectFiles (MS-8)', () => {
  it('accepts a missing, null or empty top-level list', () => {
    for (const attachments of [undefined, null, []])
      expect(() => checkNoProjectFiles(attachments)).not.toThrow();
  });

  it('refuses any project-level file with the exact message on the attachments field', () => {
    for (const attachments of [[{ id: 'file-1' }], 'file-1', {}, 0]) {
      const error = thrown(() => checkNoProjectFiles(attachments));
      expect(error.getStatus()).toBe(422);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Add files to the service they belong to.');
      expect(error.details).toEqual({ field: 'attachments' });
    }
  });
});

describe('withFieldPath', () => {
  it('adds the field to a 422 that has none and leaves other errors alone', () => {
    const plain = new AppError(
      422,
      'VALIDATION_ERROR',
      'Choose a valid service.',
    );
    const withField = withFieldPath(plain, 'services[0].serviceId') as AppError;
    expect(withField.message).toBe('Choose a valid service.');
    expect(withField.details).toEqual({ field: 'services[0].serviceId' });

    const already = new AppError(422, 'VALIDATION_ERROR', 'x', { field: 'a' });
    expect(withFieldPath(already, 'b')).toBe(already);
    const other = new Error('boom');
    expect(withFieldPath(other, 'b')).toBe(other);
    expect(withFieldPath(plain, null)).toBe(plain);
  });
});

describe('parseGroupRef', () => {
  it('parses XPG references and refuses anything else', () => {
    expect(parseGroupRef('XPG-00042')).toBe(42);
    expect(parseGroupRef('XPG-123456')).toBe(123456);
    expect(parseGroupRef(formatGroupRef(7))).toBe(7);
    for (const bad of [
      'XPG-0042',
      'XPG-00000',
      'XPR-00042',
      'xpg-00042',
      '42',
      '',
    ]) {
      expect(parseGroupRef(bad)).toBeNull();
    }
  });
});
